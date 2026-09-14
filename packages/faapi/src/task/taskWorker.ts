import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import type { TaskRegistriesSnapshot } from './taskTypes';

/**
 * 任务隔离执行器
 *
 * 任务声明 `timeoutMs` 后在独立 worker 线程中执行：Node 主线程无法强杀协程，
 * 进程内"不再等待"式的超时是假取消（控制侧记失败、重试已投递，旧协程仍在跑）；
 * worker 线程的 `terminate()` 是 Node 唯一能硬终止执行的机制——判定超时即执行真正终止。
 *
 * 取消为两段式：先向 worker 发 abort 信号（任务监听 taskCtx.signal 可优雅退出），
 * KILL_GRACE_MS 内未退出则 terminate 硬杀。超时判定即终局——宽限期内 worker
 * 迟到的完成/错误一律按超时失败返回，不翻案。
 *
 * 每次 dispatch 新建 worker：worker 模块图独立，天然加载最新任务产物
 * （dev 热替换后无需 cache-bust）；代价是每次执行的冷启动开销（仅声明超时的任务承担）。
 */

/** abort 宽限期：发出优雅取消信号后等待任务自行退出的最长时间 */
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
   * 注册表快照（纯数据，postMessage 结构化克隆传入，worker 内重建只读视图注入
   * taskCtx.registries）——语义层从 `TaskRegistriesView` 生成，缺省为空视图
   */
  registries?: TaskRegistriesSnapshot;
  /** 外部取消信号（驱动停机超时 abort）——abort 同样触发两段式取消 */
  externalSignal?: AbortSignal;
  /** 宽限期覆盖（默认 KILL_GRACE_MS）——测试注入短值用，业务不配置 */
  killGraceMs?: number;
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

/** worker 内执行的 wrapper 源码（data URL，ESM）——import 任务产物并桥接 run */
function buildWrapperSource(moduleUrl: string): string {
  return `
import { parentPort } from 'node:worker_threads';
import * as mod from '${moduleUrl}';

${BUILD_VIEW_SOURCE}

const run = mod.run;
if (typeof run !== 'function') {
  parentPort.postMessage({ type: 'error', message: 'Task module has no run export' });
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
      const result = await run(payload, { ...taskCtx, signal: controller.signal, registries });
      parentPort.postMessage({ type: 'done', result });
    } catch (err) {
      parentPort.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
`;
}

export async function runTaskInWorker(options: TaskWorkerOptions): Promise<unknown> {
  const { taskModulePath, payload, taskCtx, timeoutMs, externalSignal } = options;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

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

    worker.on('message', (msg: { type?: string; result?: unknown; message?: string }) => {
      if (phase === 'grace') {
        // 宽限期内收到消息 = run 已结束（worker 因 parentPort 监听不会自行 exit）——
        // 保持取消失败终局，立即返回；迟到的完成结果不采纳（超时判定即终局）
        if (msg?.type === 'done') {
          finish(() =>
            reject(
              new TaskCancelledError(
                `Task "${taskCtx.job.name}" ${cancelReason} (task completed after the timeout)`,
              ),
            ),
          );
        } else if (msg?.type === 'error') {
          finish(() => reject(new TaskCancelledError(msg.message ?? cancelReason)));
        }
        return;
      }
      if (phase !== 'running') return;
      if (msg?.type === 'done') {
        finish(() => resolve(msg.result));
      } else if (msg?.type === 'error') {
        finish(() => reject(new Error(msg.message ?? 'task worker error')));
      }
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
