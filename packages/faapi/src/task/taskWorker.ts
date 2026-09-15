import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import type { TaskRegistriesSnapshot } from './taskTypes';
import type { LogEntry, LogLevel } from '../logger/loggerTypes';

/**
 * 任务隔离执行器
 *
 * 任务声明 `timeoutMs` 后在独立 worker 线程中执行：Node 主线程无法强杀协程，
 * 进程内"不再等待"式的超时是假取消（控制侧记失败、重试已投递，旧协程仍在跑）；
 * worker 线程的 `terminate()` 是 Node 唯一能硬终止执行的机制——判定超时即执行真正终止。
 *
 * 取消为两段式：先向 worker 发 abort 信号（任务监听 taskCtx.signal 可优雅退出），
 * 宽限期内未退出则 terminate 硬杀（宽限期经 task meta `graceMs` 配置，默认
 * KILL_GRACE_MS 5s）。超时判定即终局——宽限期内 worker
 * 迟到的完成/错误一律按超时失败返回，不翻案。
 *
 * 每次 dispatch 新建 worker：worker 模块图独立，天然加载最新任务产物
 * （dev 热替换后无需 cache-bust）；代价是每次执行的冷启动开销（仅声明超时的任务承担）。
 */

/** abort 宽限期默认值：发出优雅取消信号后等待任务自行退出的最长时间（task meta `graceMs` 可按任务覆盖） */
const KILL_GRACE_MS = 5_000;

/**
 * 取消错误：任务执行被框架终止（执行超时两段式取消 / 停机取消）。
 * 语义层以此区分"取消"与 run 自身的失败——任务记录记 'cancelled' 而非 'failed'。
 */
export class TaskCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskCancelledError';
  }
}

/**
 * 隔离执行器签名（taskQueue 按任务 meta.timeoutMs 调用；测试可注入 spy）
 */
export type TaskWorkerRunner = typeof runTaskInWorker;

export interface TaskWorkerOptions {
  /** 任务产物模块绝对路径（`<dist>/tasks/<dir>/task.js`） */
  taskModulePath: string;
  payload: unknown;
  /** signal 由执行器构造（abort/terminate 时触发），宿主只传 config 与 job 信息 */
  taskCtx: { config: unknown; job: { id: string; name: string; attempt: number } };
  /** 单次执行超时（毫秒） */
  timeoutMs: number;
  /**
   * 取消宽限期（毫秒）——两段式取消第一段发出 abort 信号后等待任务自行退出的
   * 最长时间，超时未退出 `terminate()` 硬杀。来自 task meta `graceMs`，
   * 未声明用 `KILL_GRACE_MS`（5s）；`0` 表示不留宽限期（判定取消即硬杀）
   */
  graceMs?: number;
  /**
   * 注册表快照（纯数据，postMessage 结构化克隆传入，worker 内重建只读视图注入
   * taskCtx.registries）——语义层从 `TaskRegistriesView` 生成，缺省为空视图
   */
  registries?: TaskRegistriesSnapshot;
  /**
   * 任务日志配置（纯数据，postMessage 传入，worker 内联重建日志器注入 taskCtx.log；
   * 缺省时 taskCtx.log 为 undefined）：scope/fields 与进程内路径一致（`task:<name>`
   * + jobId/task/attempt），level 为宿主侧生效的全局级别（worker 侧预过滤，
   * 宿主 writeLogEntry 再次过滤）
   */
  log?: { level: LogLevel; scope?: string; fields?: Record<string, unknown> };
  /** 外部取消信号（驱动停机超时 abort）——abort 同样触发两段式取消 */
  externalSignal?: AbortSignal;
  /**
   * 进度回调：worker 内 `taskCtx.progress(value)` 的值经 `{ type: 'progress' }`
   * 消息回传宿主（语义层记入 `TaskJob.progress`）；不传则进度消息被忽略
   */
  onProgress?: (value: unknown) => void;
  /**
   * 日志回调：worker 内 taskCtx.log 的条目经 `{ type: 'log' }` 消息回传宿主，
   * 由语义层接 writeLogEntry 走统一管道（自定义 sink 同样覆盖隔离任务）；
   * 不传则日志条目被忽略。宽限期（取消判定后）到达的条目不采纳（超时判定即终局）
   */
  onLog?: (entry: LogEntry) => void;
}

/**
 * config 可克隆化：worker 传参经结构化克隆，含函数的配置项传不进去——
 * structuredClone 优先（保 Map/Set/Date），失败退化 JSON round-trip（丢函数留数据），
 * 再失败（循环引用等）传 undefined。任务收到的 config 是纯数据快照。
 */
function safeConfig(config: unknown): unknown {
  if (config === undefined || config === null) return config;
  try {
    structuredClone(config);
    return config;
  } catch {
    // 不可克隆：JSON 快照兜底
  }
  try {
    return JSON.parse(JSON.stringify(config));
  } catch {
    return undefined;
  }
}

/**
 * worker 内重建注册表只读视图的内联源码（语义与 agentRegistry/toolRegistry/skillRegistry
 * 的查询方法一致：不存在的 tool/agent 名静默跳过、resolveAgentTools 按解析后 name 去重）
 *
 * 注册表对象含函数闭包不可跨线程——快照为纯数据，视图必须在 worker 内重建；
 * wrapper 是 data URL 模块无法 import 主包，故内联实现（测试断言两边语义一致）。
 */
const BUILD_VIEW_SOURCE = `
function buildRegistriesView(snapshot) {
  var agents = new Map(((snapshot && snapshot.agents) || []).map(function (a) { return [a.name, a]; }));
  var tools = new Map(((snapshot && snapshot.tools) || []).map(function (t) { return [t.name, t]; }));
  var skills = new Map(((snapshot && snapshot.skills) || []).map(function (s) { return [s.name, s]; }));
  return {
    agent: {
      getAgent: function (name) { return agents.get(name); },
      getAgentEntry: function (name) { return agents.get(name); },
      listAgents: function () { return Array.from(agents.values()); },
      asTool: function (name) {
        var agent = agents.get(name);
        if (!agent) return undefined;
        return {
          kind: 'agent',
          name: 'agent.' + agent.name,
          agentName: agent.name,
          description: agent.description,
          metadata: agent,
        };
      },
      resolveAgentTools: function (name) {
        var agent = agents.get(name);
        var result = new Map();
        if (agent && agent.tools) {
          agent.tools.forEach(function (toolName) {
            var resolved = tools.get(toolName);
            if (resolved) result.set(resolved.name, resolved);
          });
        }
        return Array.from(result.values());
      },
      resolveSubAgents: function (name) {
        var agent = agents.get(name);
        var result = [];
        if (agent && agent.agents) {
          agent.agents.forEach(function (subName) {
            var sub = agents.get(subName);
            if (sub) result.push(sub);
          });
        }
        return result;
      },
    },
    tool: {
      get: function (name) { return tools.get(name); },
      list: function () { return Array.from(tools.values()); },
    },
    skill: {
      get: function (name) { return skills.get(name); },
      list: function () { return Array.from(skills.values()); },
    },
  };
}
`;

/**
 * worker 内错误序列化（错误保真）：Error 按 `{ name, message, stack, props }` 回传——
 * `props` 收集自定义可枚举属性（业务错误类的 code/statusCode 等），宿主侧重建时回填；
 * 非 Error 值按 String(err) 归一。结构化克隆只保 message（name/自定义属性丢失、
 * stack 重新生成），不序列化就无法跨线程保真。
 */
const SERIALIZE_ERROR_SOURCE = `
function serializeError(err) {
  if (err instanceof Error) {
    var props = {};
    var keys = Object.keys(err);
    for (var i = 0; i < keys.length; i++) {
      props[keys[i]] = err[keys[i]];
    }
    return { name: err.name, message: err.message, stack: err.stack, props: props };
  }
  return { name: 'Error', message: String(err), stack: undefined, props: {} };
}
`;

/**
 * worker 内任务日志器（内联源码）：级别预过滤 + scope/fields 组装，条目作为纯数据
 * 经 `{ type: 'log' }` 消息回传宿主、由宿主统一 sink 输出——wrapper 是 data URL 模块
 * 无法 import 主包，故内联实现（语义与主包 createLogger 对齐：child scope `:` 合并、
 * 调用处 fields 覆盖构造字段；格式化在宿主侧，不跨线程复制格式代码）。
 *
 * fields 含不可克隆值时丢弃 fields、保底 level/message/scope（降级已记入 fallback.md）
 * ——日志永不中断任务执行，与 progress 的"不可克隆按执行错误处理"不同。
 */
const BUILD_LOGGER_SOURCE = `
var LOG_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
function createTaskLogger(level, scope, fields) {
  function make(suffix) {
    function write(lvl, message, callFields) {
      if (LOG_RANK[lvl] < LOG_RANK[level]) return;
      var entry = { level: lvl, message: message, time: new Date().toISOString() };
      var fullScope = suffix === undefined ? scope : scope === undefined ? suffix : scope + ':' + suffix;
      if (fullScope !== undefined) entry.scope = fullScope;
      if (fields !== undefined || callFields !== undefined) {
        entry.fields = Object.assign({}, fields, callFields);
      }
      try {
        parentPort.postMessage({ type: 'log', entry: entry });
      } catch (_) {
        entry.fields = { warning: 'log fields not cloneable across worker boundary, dropped' };
        parentPort.postMessage({ type: 'log', entry: entry });
      }
    }
    return {
      debug: function (m, f) { write('debug', m, f); },
      info: function (m, f) { write('info', m, f); },
      warn: function (m, f) { write('warn', m, f); },
      error: function (m, f) { write('error', m, f); },
      child: function (cs) { return make(suffix === undefined ? cs : suffix + ':' + cs); },
    };
  }
  return make(undefined);
}
`;

/** worker 内执行的 wrapper 源码（data URL，ESM）——import 任务产物并桥接 run */
function buildWrapperSource(moduleUrl: string): string {
  return `
import { parentPort } from 'node:worker_threads';
import * as mod from '${moduleUrl}';

${BUILD_VIEW_SOURCE}

${SERIALIZE_ERROR_SOURCE}

${BUILD_LOGGER_SOURCE}

const run = mod.run;
if (typeof run !== 'function') {
  parentPort.postMessage({
    type: 'error',
    error: { name: 'Error', message: 'Task module has no run export', stack: undefined, props: {} },
  });
} else {
  let controller = null;
  parentPort.on('message', async (msg) => {
    if (msg?.type === 'abort') {
      controller?.abort(new Error(msg.reason));
      return;
    }
    if (msg?.type !== 'run') return;
    controller = new AbortController();
    const { payload, taskCtx } = msg;
    try {
      const registries = buildRegistriesView(msg.registries);
      const progress = (value) => parentPort.postMessage({ type: 'progress', value });
      const taskLog = msg.log ? createTaskLogger(msg.log.level, msg.log.scope, msg.log.fields) : undefined;
      const result = await run(payload, { ...taskCtx, signal: controller.signal, registries, progress, log: taskLog });
      parentPort.postMessage({ type: 'done', result });
    } catch (err) {
      const serialized = serializeError(err);
      try {
        parentPort.postMessage({ type: 'error', error: serialized });
      } catch (_) {
        // props 含不可克隆值（函数等）时丢弃 props，保底 name/message/stack
        parentPort.postMessage({
          type: 'error',
          error: { name: serialized.name, message: serialized.message, stack: serialized.stack, props: {} },
        });
      }
    }
  });
}
`;
}

/** worker 错误回传负载（serializeError 的结构化克隆产物） */
interface WorkerErrorPayload {
  name?: string;
  message?: string;
  stack?: string;
  props?: Record<string, unknown>;
}

/**
 * 宿主侧错误重建：new Error 后回填 name/stack/props——错误信息（含业务错误码、
 * worker 侧堆栈）跨线程保留；class 身份不跨线程（重建对象是 Error 实例），
 * `instanceof 自定义子类` 不成立，跨线程判错用 err.name / 自定义属性。
 */
function reviveError(payload: WorkerErrorPayload | undefined): Error {
  const err = new Error(payload?.message ?? 'task worker error');
  if (payload?.name !== undefined) err.name = payload.name;
  if (payload?.stack !== undefined) err.stack = payload.stack;
  if (payload?.props) {
    for (const [key, value] of Object.entries(payload.props)) {
      (err as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return err;
}

export async function runTaskInWorker(options: TaskWorkerOptions): Promise<unknown> {
  const { taskModulePath, payload, taskCtx, timeoutMs, externalSignal } = options;
  const killGraceMs = options.graceMs ?? KILL_GRACE_MS;

  // 预取消快速失败：驱动停机信号在派发时已触发（停机竞态），不创建 worker
  // ——省掉线程冷启动，也不必空等宽限期
  if (externalSignal?.aborted) {
    throw new TaskCancelledError(
      `Task "${taskCtx.job.name}" cancelled before start (driver stop signal already aborted)`,
    );
  }

  const moduleUrl = pathToFileURL(taskModulePath).href;
  const wrapperUrl = new URL(
    `data:text/javascript,${encodeURIComponent(buildWrapperSource(moduleUrl))}`,
  );

  return new Promise<unknown>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(wrapperUrl);
    } catch (err) {
      reject(err);
      return;
    }

    /** running →（超时/外部取消）grace →（宽限未退出 terminate）settled；settled 后一切事件忽略 */
    let phase: 'running' | 'grace' | 'settled' = 'running';
    let cancelReason = '';
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void): void => {
      if (phase === 'settled') return;
      phase = 'settled';
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      void worker.terminate();
      settle();
    };

    /** 两段式取消第一段：发优雅取消信号，宽限未退出再 terminate */
    const startCancel = (reason: string): void => {
      if (phase !== 'running') return;
      phase = 'grace';
      cancelReason = reason;
      worker.postMessage({ type: 'abort', reason });
      graceTimer = setTimeout(() => {
        finish(() =>
          reject(new TaskCancelledError(`Task "${taskCtx.job.name}" ${reason} and was terminated`)),
        );
      }, killGraceMs);
    };

    const onExternalAbort = (): void => startCancel('cancelled (driver stop timeout)');
    if (externalSignal) {
      if (externalSignal.aborted) {
        onExternalAbort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    const timeoutTimer: ReturnType<typeof setTimeout> = setTimeout(
      () => startCancel(`timed out after ${timeoutMs}ms`),
      timeoutMs,
    );

    worker.on(
      'message',
      (msg: {
        type?: string;
        result?: unknown;
        error?: WorkerErrorPayload;
        value?: unknown;
        entry?: LogEntry;
      }) => {
        if (phase === 'grace') {
          // 宽限期内收到消息 = run 已结束（worker 因 parentPort 监听不会自行 exit）——
          // 保持取消失败终局，立即返回；迟到的完成结果/进度不采纳（超时判定即终局）
          if (msg?.type === 'done') {
            finish(() =>
              reject(
                new TaskCancelledError(
                  `Task "${taskCtx.job.name}" ${cancelReason} (task completed after the timeout)`,
                ),
              ),
            );
          } else if (msg?.type === 'error') {
            finish(() => reject(new TaskCancelledError(msg.error?.message ?? cancelReason)));
          }
          return;
        }
        if (phase !== 'running') return;
        if (msg?.type === 'done') {
          finish(() => resolve(msg.result));
        } else if (msg?.type === 'error') {
          finish(() => reject(reviveError(msg.error)));
        } else if (msg?.type === 'progress') {
          options.onProgress?.(msg.value);
        } else if (msg?.type === 'log') {
          options.onLog?.(msg.entry!);
        }
      },
    );
    worker.on('messageerror', () => {
      // 消息反序列化失败（罕见——能通过发送端序列化的消息极少在接收端失败），
      // 按执行错误终局，不悬挂等待超时
      finish(() =>
        reject(new Error(`Task "${taskCtx.job.name}" worker message could not be deserialized`)),
      );
    });
    worker.on('error', (err) => {
      finish(() => reject(err));
    });
    worker.on('exit', (code: number) => {
      // 宽限阶段 worker 意外退出（任务进程死亡、未发结束消息）——保持取消失败终局
      if (phase === 'grace') {
        finish(() => reject(new TaskCancelledError(`Task "${taskCtx.job.name}" ${cancelReason}`)));
      } else if (phase === 'running') {
        finish(() => reject(new Error(`Task worker exited unexpectedly (code ${code})`)));
      }
    });

    // taskCtx.config 为可克隆快照（含函数的配置项 JSON 快照兜底）；registries 为纯数据
    // 快照（registries?: TaskRegistriesSnapshot，缺省 undefined → worker 内空视图）
    // postMessage 不可克隆时按错误处理
    try {
      worker.postMessage({
        type: 'run',
        payload,
        taskCtx: { config: safeConfig(taskCtx.config), job: taskCtx.job },
        registries: options.registries,
        log: options.log,
      });
    } catch (err) {
      finish(() =>
        reject(
          new Error(`Task "${taskCtx.job.name}" payload/config is not cloneable: ${String(err)}`),
        ),
      );
    }
  });
}
