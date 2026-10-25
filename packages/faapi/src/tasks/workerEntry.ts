import { parentPort, workerData } from 'node:worker_threads';
import type { TaskRegistriesSnapshot, TaskClient } from './taskTypes';
import type { LlmComplete, LlmCompleteOptions } from '../injection/llmTypes';
import type { LogEntry, LogLevel } from '../loggers/loggerTypes';

/**
 * 任务隔离 worker 的真实入口文件（tsup 独立入口 → dist/workerEntry.js）
 *
 * 为什么是独立文件而不是宿主生成的 data URL：data URL 模块无法解析裸说明符
 * （'@faapi/faapi'），framework 侧 helper 只能以字符串模板内联（typecheck 覆盖
 * 不到、需对照测试锚定漂移），且求值顺序需人肉控制；真实入口文件是隔离执行的
 * 通行形态（vitest / bullmq / piscina 同款）——入口自身的语句先于对用户任务
 * 模块的动态 import 执行，"读取根播种先于任务模块求值"由结构保证。
 *
 * 本文件自包含：值导入仅 node:worker_threads，其余全部 type-only（类型剥离后
 * 擦除）——vitest 场景宿主会回退到 src 源文件直跑（resolveWorkerEntryUrl，见
 * taskWorker.ts），无相对导入链才无扩展名解析问题。读取根经 globalThis +
 * Symbol.for 承载而非模块状态：入口 bundle 与 index bundle 是两份代码副本，
 * globalThis 是唯一跨副本共享面（symbol key 与 utils/readResource 的
 * 'faapi.resources.dir' 一致，两处字面量需同步，readResource.test.ts 契约测试
 * 锚定）。主线程 import 本模块仅取导出的纯函数（bootstrap 被 parentPort 守卫），
 * 真实 worker 由 taskWorker.ts 创建。
 */

/** workerData 契约（taskWorker.ts 构造 worker 时传入） */
export interface WorkerEntryData {
  /** 任务产物模块 file:// URL（首次 run 消息时动态 import） */
  moduleUrl: string;
  /** 产物 resources 目录绝对路径（缺省不播种——readResource 未绑定即显式抛错） */
  resourcesDir?: string;
}

/**
 * sub-agent 派发工具名前缀（与 injection/subAgentToolName.ts 的 SUB_AGENT_TOOL_PREFIX
 * 同步——本文件自包含不可值导入，taskWorker.test.ts 断言完整派发名锚定漂移）。
 * 快照内的 agent 名来自文件注册表（scanAgents 构建期已校验字符集），直拼即合法。
 */
const SUB_AGENT_TOOL_PREFIX = 'agent-';

/** worker 错误回传负载（serializeError 的产物，宿主 reviveError 重建） */
export interface SerializedWorkerError {
  name: string;
  message: string;
  stack: string | undefined;
  props: Record<string, unknown>;
}

/**
 * worker 内重建注册表只读视图（语义与宿主 createTaskRegistriesView 一致：
 * 不存在的 tool/agent 名静默跳过、resolveAgentTools 按解析后 name 去重）
 *
 * 快照为纯数据（函数闭包不可跨线程），视图在 worker 内重建。
 */
export function buildRegistriesView(snapshot?: TaskRegistriesSnapshot) {
  const agents = new Map((snapshot?.agents ?? []).map((a) => [a.name, a] as const));
  const tools = new Map((snapshot?.tools ?? []).map((t) => [t.name, t] as const));
  return {
    agent: {
      getAgent: (name: string) => agents.get(name),
      getAgentEntry: (name: string) => agents.get(name),
      listAgents: () => Array.from(agents.values()),
      asTool: (name: string) => {
        const agent = agents.get(name);
        if (!agent) return undefined;
        return {
          kind: 'agent' as const,
          name: `${SUB_AGENT_TOOL_PREFIX}${agent.name}`,
          agentName: agent.name,
          description: agent.description,
          metadata: agent,
        };
      },
      resolveAgentTools: (name: string) => {
        const agent = agents.get(name);
        const result = new Map<string, TaskRegistriesSnapshot['tools'][number]>();
        if (agent?.tools) {
          for (const toolName of agent.tools) {
            const resolved = tools.get(toolName);
            if (resolved) result.set(resolved.name, resolved);
          }
        }
        return Array.from(result.values());
      },
      resolveSubAgents: (name: string) => {
        const agent = agents.get(name);
        const result: TaskRegistriesSnapshot['agents'] = [];
        if (agent?.agents) {
          for (const subName of agent.agents) {
            const sub = agents.get(subName);
            if (sub) result.push(sub);
          }
        }
        return result;
      },
    },
    tool: {
      get: (name: string) => tools.get(name),
      list: () => Array.from(tools.values()),
    },
  };
}

/**
 * worker 内错误序列化（错误保真）：Error 按 `{ name, message, stack, props }` 回传——
 * `props` 收集自定义可枚举属性（业务错误类的 code/statusCode 等），宿主侧 reviveError
 * 重建时回填；非 Error 值按 String(err) 归一。结构化克隆只保 message（name/自定义
 * 属性丢失、stack 重新生成），不序列化就无法跨线程保真。
 */
export function serializeError(err: unknown): SerializedWorkerError {
  if (err instanceof Error) {
    const props: Record<string, unknown> = {};
    for (const key of Object.keys(err)) {
      props[key] = (err as unknown as Record<string, unknown>)[key];
    }
    return { name: err.name, message: err.message, stack: err.stack, props };
  }
  return { name: 'Error', message: String(err), stack: undefined, props: {} };
}

const LOG_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * taskCtx.llm 轻量补全代理（worker 侧）——隔离任务一次性补全的纯转发通道
 *
 * `taskCtx.llm.complete(input, options)` 经 `{ type: 'llm-complete', seq, input,
 * options }` 消息回传宿主，宿主从 AppRegistries.llm 取注册的补全通道执行（LLM IO
 * 全在宿主——worker 纯转发，不加载 `@faapi/agent`），以 `{ type: 'llm-result',
 * seq, ok, value | error }` 回传——按 seq 匹配挂起调用。
 *
 * options 前置校验（本地报错，不发 RPC）：`onFailure` 钩子为函数不可跨线程——
 * 显式拒绝并指引在任务内 try/catch 自行实现失败副作用；`signal` 不可结构化克隆
 * ——剥离后转发，业务级取消（任务内自建 AbortController）经 `{ type: 'llm-abort',
 * seq }` 消息回传宿主 abort 对应请求（错误经 llm-result 回传，与 LlmCompleteOptions
 * 契约一致：取消透传到底层 HTTP 请求）。注意业务级取消与任务取消（两段式）是两
 * 回事：任务取消不传播宿主（worker 纯转发原则），挂起的 complete 随任务终止一并
 * 消失，无独立超时。
 *
 * 纯函数形态（send 注入）：真实 worker 传 parentPort.postMessage，单测直接构造。
 */
export function buildLlmProxy(send: (msg: Record<string, unknown>) => void): {
  proxy: LlmComplete;
  /** 处理 llm-result 消息：命中返回 true（消息已消费），其余返回 false */
  handleMessage: (msg: {
    type?: string;
    seq?: number;
    ok?: boolean;
    value?: unknown;
    error?: SerializedWorkerError;
  }) => boolean;
} {
  let seq = 0;
  const pending = new Map<
    number,
    { resolve: (value: string) => void; reject: (err: Error) => void }
  >();

  const proxy: LlmComplete = {
    complete: (input, options) => {
      const opts = options as (LlmCompleteOptions & Record<string, unknown>) | undefined;
      if (typeof opts?.onFailure === 'function') {
        return Promise.reject(
          new Error(
            'taskCtx.llm.complete options.onFailure is not available in the isolated task ' +
              'context — callback functions cannot cross the worker boundary. Implement ' +
              'failure side effects with try/catch around the await instead.',
          ),
        );
      }
      const signal = opts?.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        return Promise.reject(
          new Error('taskCtx.llm.complete options.signal must be an AbortSignal'),
        );
      }
      return new Promise<string>((resolve, reject) => {
        const s = ++seq;
        pending.set(s, { resolve, reject });
        try {
          const payload: Record<string, unknown> = { type: 'llm-complete', seq: s, input };
          if (opts !== undefined) {
            const { signal: _signal, ...rest } = opts;
            if (Object.keys(rest).length > 0) payload.options = rest;
            if (signal !== undefined) {
              if (signal.aborted) {
                pending.delete(s);
                reject(new Error('taskCtx.llm.complete was aborted before dispatch'));
                return;
              }
              // 业务级取消转发：abort → 宿主 abort 对应请求（错误经 llm-result 回传）
              signal.addEventListener('abort', () => send({ type: 'llm-abort', seq: s }), {
                once: true,
              });
            }
          }
          send(payload);
        } catch (err) {
          pending.delete(s);
          reject(
            new Error(
              `taskCtx.llm.complete arguments are not cloneable across the worker boundary: ` +
                `${err instanceof Error ? err.message : String(err)}. ` +
                'Keep input / options plain data (strings / numbers / plain objects).',
              { cause: err },
            ),
          );
        }
      });
    },
  };

  return {
    proxy,
    handleMessage: (msg) => {
      if (msg?.type !== 'llm-result') return false;
      const entry = msg.seq !== undefined ? pending.get(msg.seq) : undefined;
      if (!entry) return true; // 迟到/未知 seq（取消终止后到达）——忽略
      pending.delete(msg.seq!);
      if (msg.ok) {
        entry.resolve(msg.value as string);
      } else {
        const err = new Error(msg.error?.message ?? 'taskCtx.llm.complete failed');
        if (msg.error?.name !== undefined) err.name = msg.error.name;
        entry.reject(err);
      }
      return true;
    },
  };
}

/**
 * 任务日志器：级别预过滤（level 为 undefined 时不过滤——宿主文件管道默认全量）+
 * scope/fields 组装，条目作为纯数据经 `{ type: 'log' }` 消息回传宿主、由宿主统一
 * sink 输出（语义与主包 createLogger 对齐：child scope `:` 合并、调用处 fields
 * 覆盖构造字段；格式化在宿主侧，不跨线程复制格式代码）。
 *
 * fields 含不可克隆值时按执行错误处理（与 progress 同语义，不降级）——一条日志的
 * 字段失败终止任务执行：显式失败优于静默丢字段，业务侧将 fields 保持为可克隆
 * 纯数据即可避免。
 */
export function createTaskLogger(
  level?: LogLevel,
  scope?: string,
  fields?: Record<string, unknown>,
) {
  const make = (suffix?: string) => {
    const write = (lvl: LogLevel, message: string, callFields?: Record<string, unknown>) => {
      if (level !== undefined && LOG_RANK[lvl] < LOG_RANK[level]) return;
      const entry: LogEntry = { level: lvl, message, time: new Date().toISOString() };
      const fullScope =
        suffix === undefined ? scope : scope === undefined ? suffix : `${scope}:${suffix}`;
      if (fullScope !== undefined) entry.scope = fullScope;
      if (fields !== undefined || callFields !== undefined) {
        entry.fields = { ...fields, ...callFields };
      }
      try {
        parentPort?.postMessage({ type: 'log', entry });
      } catch (err) {
        throw new Error(
          `task log fields are not cloneable across the worker boundary: ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            'Keep log fields plain data (strings / numbers / plain objects).',
          { cause: err },
        );
      }
    };
    return {
      debug: (m: string, f?: Record<string, unknown>) => write('debug', m, f),
      info: (m: string, f?: Record<string, unknown>) => write('info', m, f),
      warn: (m: string, f?: Record<string, unknown>) => write('warn', m, f),
      error: (m: string, f?: Record<string, unknown>) => write('error', m, f),
      child: (cs: string) => make(suffix === undefined ? cs : `${suffix}:${cs}`),
    };
  };
  return make(undefined);
}

/**
 * 隔离任务 taskCtx.tasks 代理工厂（worker 侧）
 *
 * 全方法经 `{ type: 'tasks-call', seq, method, args }` 消息回传宿主执行，宿主以
 * `{ type: 'tasks-result', seq, ok, value | error }` 回传——按 seq 匹配挂起调用。
 * 参数与返回值须可结构化克隆（不可克隆按调用错误抛出，与 progress/log 同口径，
 * 不静默）；挂起的调用随任务超时两段式取消（terminate）一并终止，无独立超时。
 *
 * 纯函数形态（send/handleMessage 注入）：真实 worker 传 parentPort.postMessage，
 * 单测直接构造（与 buildRegistriesView 同款可测性）。
 */
export function buildTasksProxy(send: (msg: Record<string, unknown>) => void): {
  proxy: TaskClient;
  handleMessage: (msg: {
    type?: string;
    seq?: number;
    ok?: boolean;
    value?: unknown;
    error?: SerializedWorkerError;
  }) => boolean;
} {
  let seq = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; method: string }
  >();

  const call = (method: string, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const s = ++seq;
      pending.set(s, { resolve, reject, method });
      try {
        send({ type: 'tasks-call', seq: s, method, args });
      } catch (err) {
        pending.delete(s);
        reject(
          new Error(
            `taskCtx.tasks.${method} arguments are not cloneable across the worker boundary: ` +
              `${err instanceof Error ? err.message : String(err)}. ` +
              'Keep arguments plain data (strings / numbers / plain objects).',
            { cause: err },
          ),
        );
      }
    });

  return {
    proxy: {
      enqueue: (name, payload, opts) =>
        call('enqueue', [name, payload, opts]) as ReturnType<TaskClient['enqueue']>,
      // 链式投递：excludeJobId 由宿主侧分派注入（调用方自身），worker 侧原样透传
      enqueueChain: (name, payload, opts) =>
        call('enqueueChain', [name, payload, opts]) as ReturnType<TaskClient['enqueueChain']>,
      enqueueGroup: (name, payloads, opts) =>
        call('enqueueGroup', [name, payloads, opts]) as ReturnType<TaskClient['enqueueGroup']>,
      // 激活：与进程内同语义（宿主侧走完整 resume 通道，信封读出即删）；
      // worker 自身挂起走 taskCtx.suspend（独立 RPC 通道），此处是激活别人
      resume: (name, jobId, opts) =>
        call('resume', [name, jobId, opts]) as ReturnType<TaskClient['resume']>,
      getGroup: (groupId) => call('getGroup', [groupId]) as ReturnType<TaskClient['getGroup']>,
      list: (name) => call('list', [name]) as unknown as ReturnType<TaskClient['list']>,
      listQueued: (name) =>
        call('listQueued', [name]) as unknown as ReturnType<TaskClient['listQueued']>,
      listEvents: (name, opts) =>
        call('listEvents', [name, opts]) as unknown as ReturnType<TaskClient['listEvents']>,
      cancel: (name, id) => call('cancel', [name, id]) as ReturnType<TaskClient['cancel']>,
      retry: (name, id) => call('retry', [name, id]) as ReturnType<TaskClient['retry']>,
      // 订阅是回调签名（handler 与退订函数都不可结构化克隆）——隔离任务显式拒绝，
      // 不发 RPC（宿主侧白名单同样不放行）；事件消费在宿主侧订阅或经 listEvents 查询
      subscribe: () => {
        throw new Error(
          '[faapi] TaskClient.subscribe is not available in the isolated task context — ' +
            'event subscription is host-side only (callbacks cannot cross the worker ' +
            'boundary). Subscribe on the host queue, or query history via listEvents.',
        );
      },
    },
    handleMessage: (msg) => {
      if (msg?.type !== 'tasks-result') return false;
      const entry = msg.seq !== undefined ? pending.get(msg.seq) : undefined;
      if (!entry) return true; // 迟到/未知 seq（取消终止后到达）——忽略
      pending.delete(msg.seq!);
      if (msg.ok) {
        entry.resolve(msg.value);
      } else {
        const err = new Error(msg.error?.message ?? `taskCtx.tasks.${entry.method} failed`);
        if (msg.error?.name !== undefined) err.name = msg.error.name;
        entry.reject(err);
      }
      return true;
    },
  };
}

/**
 * agent-run RPC 代理（worker 侧）——隔离任务 `taskCtx.agent` 的 run-only 句柄
 *
 * `taskCtx.agent.run(input, options)` 经单次 `{ type: 'agent-run', seq, agentName,
 * input, options }` 消息回传宿主，宿主构造 Agent 跑完整编排循环（工具/钩子/
 * reminders/sub-agent 全在宿主），以 `{ type: 'agent-run-result', seq, ok,
 * value | error }` 回传——按 seq 匹配挂起调用。流式不支持（句柄 run-only）。
 *
 * worker 侧前置校验（本地报错，不发 RPC）：
 * - `options.agent` 缺失/非 string——agent 名是调用侧决策（与 AgentHandle 同语义）
 * - `options.provider` 为 LLMProvider 实例（有 complete/stream 方法）——实例不可
 *   跨线程，显式报错指引传 LlmConfig 纯数据
 * - 请求整体不可结构化克隆——按调用错误拒绝（与 tasks-call 同口径）
 *
 * 挂起的调用随任务超时两段式取消（terminate）一并终止，无独立超时。
 * 纯函数形态（send 注入）：真实 worker 传 parentPort.postMessage，单测直接构造。
 */
export function buildAgentRunProxy(send: (msg: Record<string, unknown>) => void): {
  /** run-only 句柄（AgentRpcHandle 的运行时形态——options.agent 即目标 agent 名） */
  run: (
    input?: string | Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  /** 处理 agent-run-result 消息：命中返回 true（消息已消费），其余返回 false */
  handleMessage: (msg: {
    type?: string;
    seq?: number;
    ok?: boolean;
    value?: unknown;
    error?: SerializedWorkerError;
  }) => boolean;
} {
  let seq = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  /** LLMProvider 实例判别（与 @faapi/agent agent.ts 的 isProviderInstance 同款结构判定
   * ——本文件自包含不可值导入，有 complete/stream 方法即实例） */
  const isProviderInstance = (value: unknown): boolean =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { complete?: unknown }).complete === 'function' &&
    typeof (value as { stream?: unknown }).stream === 'function';

  const run = (
    input?: string | Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown> => {
    if (options !== undefined && (typeof options !== 'object' || Array.isArray(options))) {
      return Promise.reject(
        new Error(
          'taskCtx.agent.run options must be a plain object of run-level overrides ' +
            '(model / temperature / maxTokens / messages / provider).',
        ),
      );
    }
    const agentName = (options as { agent?: unknown } | undefined)?.agent;
    if (typeof agentName !== 'string' || agentName.trim() === '') {
      return Promise.reject(
        new Error(
          'taskCtx.agent.run requires options.agent (the target agent name) — ' +
            'there is no default agent, same as the AgentHandle contract.',
        ),
      );
    }
    if (isProviderInstance((options as { provider?: unknown }).provider)) {
      return Promise.reject(
        new Error(
          'taskCtx.agent.run options.provider must be an LlmConfig plain object — ' +
            'LLMProvider instances cannot cross the worker boundary. Pass the config ' +
            '(apiKey / baseURL / models) and let the host create the provider.',
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const s = ++seq;
      pending.set(s, { resolve, reject });
      try {
        send({
          type: 'agent-run',
          seq: s,
          agentName,
          ...(input !== undefined ? { input } : {}),
          ...(options !== undefined ? { options } : {}),
        });
      } catch (err) {
        pending.delete(s);
        reject(
          new Error(
            'taskCtx.agent.run arguments are not cloneable across the worker boundary: ' +
              `${err instanceof Error ? err.message : String(err)}. ` +
              'Keep input / options plain data (strings / numbers / plain objects).',
            { cause: err },
          ),
        );
      }
    });
  };

  return {
    run,
    handleMessage: (msg) => {
      if (msg?.type !== 'agent-run-result') return false;
      const entry = msg.seq !== undefined ? pending.get(msg.seq) : undefined;
      if (!entry) return true; // 迟到/未知 seq（取消终止后到达）——忽略
      pending.delete(msg.seq!);
      if (msg.ok) {
        entry.resolve(msg.value);
      } else {
        const err = new Error(msg.error?.message ?? 'taskCtx.agent.run failed');
        if (msg.error?.name !== undefined) err.name = msg.error.name;
        entry.reject(err);
      }
      return true;
    },
  };
}

/**
 * 构建隔离任务 `taskCtx.suspend` 通道（workerEntry 纯函数，主线程可单测）
 *
 * 挂起经 `{ type: 'suspend', seq, state }` 消息 RPC 回传宿主执行信封持久化
 * （与进程内路径共用同一写入，语义与进程内零差）；宿主以
 * `{ type: 'suspend-result', seq, ok, error? }` 回传。state 不可克隆时发送端
 * postMessage 同步抛错 → reject 克隆指引错误（与 emit/log 同口径，不发 RPC）；
 * 宿主拒绝（驱动无 `taskState` 等）错误原样回传 reject。
 */
export function buildSuspendChannel(send: (msg: Record<string, unknown>) => void): {
  /** worker 内挂起：await 直到宿主信封写入完成（run 返回后落账 suspended） */
  suspend: (state?: unknown) => Promise<void>;
  /** 处理 suspend-result 消息：命中返回 true（消息已消费），其余返回 false */
  handleMessage: (msg: {
    type?: string;
    seq?: number;
    ok?: boolean;
    error?: { name?: string; message?: string; stack?: string; props?: Record<string, unknown> };
  }) => boolean;
} {
  let seq = 0;
  const pending = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();
  return {
    suspend: (state?: unknown) =>
      new Promise<void>((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        try {
          send({ type: 'suspend', seq: id, state });
        } catch (err) {
          pending.delete(id);
          reject(
            new Error(
              `taskCtx.suspend state is not cloneable across the worker boundary: ` +
                `${err instanceof Error ? err.message : String(err)}. ` +
                'Keep the suspend state plain data (strings / numbers / plain objects).',
              { cause: err },
            ),
          );
        }
      }),
    handleMessage: (msg) => {
      if (msg?.type !== 'suspend-result') return false;
      const id = msg.seq;
      if (id === undefined || !pending.has(id)) return true; // 迟到/未知 seq：消费掉
      const entry = pending.get(id)!;
      pending.delete(id);
      if (msg.ok) {
        entry.resolve();
      } else {
        const err = new Error(msg.error?.message ?? 'taskCtx.suspend failed');
        if (msg.error?.name !== undefined) err.name = msg.error.name;
        entry.reject(err);
      }
      return true;
    },
  };
}

/**
 * worker 侧 bootstrap：播种读取根 + 桥接 run 消息
 *
 * 仅在 worker 线程执行（主线程 import 本模块时 parentPort 为空，只取上面的纯
 * 函数）。任务模块在首次 run 消息时才动态 import（modulePromise 缓存）——播种
 * 语句先于它执行，任务模块顶层代码（top-level await 调用 readResource）读到
 * 的绑定必然已就位。
 */
function bootstrap(): void {
  if (!parentPort) return;
  const data = workerData as WorkerEntryData;

  // 播种全局 readResource 读取根（缺省不播种——直接构造队列的测试/嵌入场景，
  // readResource 未绑定即显式抛错）
  if (data.resourcesDir) {
    (globalThis as Record<symbol, string | undefined>)[Symbol.for('faapi.resources.dir')] =
      data.resourcesDir;
  }

  // taskCtx.tasks 代理：全方法经消息回传宿主（onTasksCall 分派到队列本体）
  const tasksProxy = buildTasksProxy((msg) => parentPort?.postMessage(msg));
  // taskCtx.suspend 通道：挂起经消息回传宿主执行信封持久化（onSuspend 与进程内
  // 路径共用同一写入）
  const suspendChannel = buildSuspendChannel((msg) => parentPort?.postMessage(msg));
  // agent-run 代理：taskCtx.agent.run 单次 RPC 回传宿主跑完整循环（onAgentRun 分派
  // 到 agentRunner + 任务合成契约 ctx）
  const agentRunProxy = buildAgentRunProxy((msg) => parentPort?.postMessage(msg));
  // llm 补全代理：taskCtx.llm.complete 纯转发回宿主执行（onLlmComplete 分派到
  // AppRegistries.llm 注册的补全通道——worker 不加载 @faapi/agent）
  const llmProxy = buildLlmProxy((msg) => parentPort?.postMessage(msg));

  let controller: AbortController | null = null;
  let modulePromise: Promise<{ run?: (payload: unknown, taskCtx: unknown) => unknown }> | null =
    null;

  parentPort.on(
    'message',
    (msg: {
      type?: string;
      reason?: string;
      payload?: unknown;
      /** job + config 纯数据快照（collectConfigSnapshot 投影）+ carry 执行上下文快照 + resumed 挂起/激活上下文 */
      taskCtx?: {
        job?: { id: string; name: string; attempt: number };
        config?: unknown;
        carry?: Record<string, unknown>;
        resumed?: { state?: unknown; inject?: unknown; activations: number };
      };
      registries?: TaskRegistriesSnapshot;
      /** 隔离 llm 通道开关（宿主 AppRegistries.llm 已注册通道时 true——worker 挂载纯转发代理） */
      llmChannel?: boolean;
      /** 隔离 agent 通道开关（宿主 agentRunner 已注册时 true——worker 挂载 taskCtx.agent） */
      agentChannel?: boolean;
      log?: { level?: LogLevel; scope?: string; fields?: Record<string, unknown> };
    }) => {
      if (suspendChannel.handleMessage(msg as Parameters<typeof suspendChannel.handleMessage>[0]))
        return;
      if (tasksProxy.handleMessage(msg as Parameters<typeof tasksProxy.handleMessage>[0])) return;
      if (agentRunProxy.handleMessage(msg as Parameters<typeof agentRunProxy.handleMessage>[0]))
        return;
      if (llmProxy.handleMessage(msg as Parameters<typeof llmProxy.handleMessage>[0])) return;
      if (msg?.type === 'abort') {
        controller?.abort(new Error(msg.reason));
        return;
      }
      if (msg?.type !== 'run') return;
      controller = new AbortController();
      const { payload, taskCtx } = msg;
      void (async () => {
        try {
          modulePromise ??= import(data.moduleUrl);
          const mod = await modulePromise;
          const run = mod.run;
          if (typeof run !== 'function') {
            parentPort?.postMessage({
              type: 'error',
              error: {
                name: 'Error',
                message: 'Task module has no run export',
                stack: undefined,
                props: {},
              },
            });
            return;
          }
          const registries = buildRegistriesView(msg.registries);
          const progress = (value: unknown) => parentPort?.postMessage({ type: 'progress', value });
          // 事件出口：值经 { type: 'event' } 消息回传宿主落事件缓冲（宿主侧仅 running
          // 采纳 + 宽限期不采纳）。值不可克隆时任务显式失败（与 log fields 同口径，
          // 不静默丢事件）——错误信息含修复指引
          const emit = (data: unknown) => {
            try {
              parentPort?.postMessage({ type: 'event', value: data });
            } catch (err) {
              throw new Error(
                `task event data is not cloneable across the worker boundary: ` +
                  `${err instanceof Error ? err.message : String(err)}. ` +
                  'Keep event data plain data (strings / numbers / plain objects).',
                { cause: err },
              );
            }
          };
          const taskLog = msg.log
            ? createTaskLogger(msg.log.level, msg.log.scope, msg.log.fields)
            : undefined;
          // 轻量补全通道：纯转发代理（complete 经 RPC 回宿主执行——worker 不加载
          // @faapi/agent）；宿主 llm 通道未注册时 undefined（能力不存在非降级）
          const llm = msg.llmChannel === true ? llmProxy.proxy : undefined;
          // 隔离 agent 通道：宿主 agentRunner 已注册（agentChannel）时挂载 run-only
          // 句柄——taskCtx.agent.run 单次 RPC 回传宿主跑完整循环（编排收敛宿主）
          const agent = msg.agentChannel === true ? { run: agentRunProxy.run } : undefined;
          const result = await run(payload, {
            ...taskCtx,
            signal: controller!.signal,
            tasks: tasksProxy.proxy,
            ...(taskCtx?.config !== undefined ? { config: taskCtx.config } : {}),
            registries,
            llm,
            ...(msg.agentChannel === true ? { agent } : {}),
            progress,
            emit,
            ...(taskCtx?.resumed !== undefined ? { resumed: taskCtx.resumed } : {}),
            suspend: suspendChannel.suspend,
            log: taskLog,
          });
          parentPort?.postMessage({ type: 'done', result });
        } catch (err) {
          const serialized = serializeError(err);
          try {
            parentPort?.postMessage({ type: 'error', error: serialized });
          } catch (cloneErr) {
            // props 含不可克隆值（函数等）：任务显式失败，不静默丢属性——宿主必须
            // 知道错误的自定义属性无法跨线程传递（错误信息含原 name/message 与修复指引）
            parentPort?.postMessage({
              type: 'error',
              error: {
                name: serialized.name,
                message:
                  `task error props are not cloneable (custom enumerable properties of the ` +
                  `thrown error cannot cross the worker boundary): ${serialized.name}: ` +
                  `${serialized.message}. Clone failure: ` +
                  `${cloneErr instanceof Error ? cloneErr.message : String(cloneErr)}. ` +
                  'Make error props plain data (string codes / numbers), not functions or class instances.',
                stack: serialized.stack,
                props: {},
              },
            });
          }
        }
      })();
    },
  );
}

bootstrap();
