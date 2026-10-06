import { parentPort, workerData } from 'node:worker_threads';
import type { TaskRegistriesSnapshot } from './taskTypes';
import type { LogEntry, LogLevel } from '../logger/loggerTypes';

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
  const skills = new Map((snapshot?.skills ?? []).map((s) => [s.name, s] as const));
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
    skill: {
      get: (name: string) => skills.get(name),
      list: () => Array.from(skills.values()),
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
 * 任务日志器：级别预过滤（level 为 undefined 时不过滤——宿主文件管道默认全量）+
 * scope/fields 组装，条目作为纯数据经 `{ type: 'log' }` 消息回传宿主、由宿主统一
 * sink 输出（语义与主包 createLogger 对齐：child scope `:` 合并、调用处 fields
 * 覆盖构造字段；格式化在宿主侧，不跨线程复制格式代码）。
 *
 * fields 含不可克隆值时丢弃 fields、保底 level/message/scope（降级已记入
 * fallback.md）——日志永不中断任务执行，与 progress 的"不可克隆按执行错误处理"
 * 不同。
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
      } catch {
        entry.fields = { warning: 'log fields not cloneable across worker boundary, dropped' };
        parentPort?.postMessage({ type: 'log', entry });
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

  let controller: AbortController | null = null;
  let modulePromise: Promise<{ run?: (payload: unknown, taskCtx: unknown) => unknown }> | null =
    null;

  parentPort.on(
    'message',
    (msg: {
      type?: string;
      reason?: string;
      payload?: unknown;
      taskCtx?: Record<string, unknown>;
      registries?: TaskRegistriesSnapshot;
      log?: { level?: LogLevel; scope?: string; fields?: Record<string, unknown> };
    }) => {
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
          const taskLog = msg.log
            ? createTaskLogger(msg.log.level, msg.log.scope, msg.log.fields)
            : undefined;
          const result = await run(payload, {
            ...taskCtx,
            signal: controller!.signal,
            registries,
            progress,
            log: taskLog,
          });
          parentPort?.postMessage({ type: 'done', result });
        } catch (err) {
          const serialized = serializeError(err);
          try {
            parentPort?.postMessage({ type: 'error', error: serialized });
          } catch {
            // props 含不可克隆值（函数等）时丢弃 props，保底 name/message/stack
            parentPort?.postMessage({
              type: 'error',
              error: {
                name: serialized.name,
                message: serialized.message,
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
