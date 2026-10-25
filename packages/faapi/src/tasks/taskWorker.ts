import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TaskRegistriesSnapshot } from './taskTypes';
import type { AgentRunRequest } from '../injection/registries';
import type { WorkerEntryData, SerializedWorkerError } from './workerEntry';
import type { LogEntry, LogLevel } from '../loggers/loggerTypes';

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
 * 每次 dispatch 新建 worker（入口为 [workerEntry](./workerEntry.ts)：moduleUrl/
 * resourcesDir 经 workerData 传入，读取根播种先于任务模块求值由结构保证）——
 * worker 模块图独立，天然加载最新任务产物（dev 热替换后无需 cache-bust）；代价
 * 是每次执行的冷启动开销（仅声明超时的任务承担）。
 */

/**
 * 解析 worker 入口文件 URL（模块级缓存）
 *
 * - dist 产物：入口与宿主同目录（tsup 多入口，`dist/workerEntry.js`）
 * - src 源码直跑（vitest）：回退同目录 `.ts`——workerEntry 自包含（值导入仅
 *   node:worker_threads），Node 原生类型剥离可直载，无扩展名解析问题
 */
let workerEntryUrl: URL | undefined;
function resolveWorkerEntryUrl(): URL {
  if (workerEntryUrl) return workerEntryUrl;
  const js = new URL('./workerEntry.js', import.meta.url);
  workerEntryUrl = existsSync(fileURLToPath(js))
    ? js
    : new URL('./workerEntry.ts', import.meta.url);
  return workerEntryUrl;
}

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
  /** signal 由执行器构造（abort/terminate 时触发），宿主只传 job 信息 */
  taskCtx: {
    /**
     * 产物 resources 目录绝对路径（纯字符串可结构化克隆）——经 workerData
     * 传给入口在任务模块求值前播种全局读取根（内部字段，不进业务 taskCtx）
     */
    resourcesDir?: string;
    job: { id: string; name: string; attempt: number };
    /**
     * 进程配置的纯数据快照（语义层经 `collectConfigSnapshot` 投影后必传；
     * 直接构造执行器的测试可不传——worker 内 taskCtx.config 为 undefined）。
     * 函数值不进快照（宿主回调面不跨线程，见 configSnapshot.md）
     */
    config?: unknown;
    /**
     * enqueue 时携带的执行上下文快照（语义层透传 `job.carry`，纯数据已校验；
     * 未携带/旧格式任务由语义层归一为空对象——worker 内 taskCtx.carry 恒有）
     */
    carry?: Record<string, unknown>;
    /**
     * 挂起/激活上下文（`tasks.resume` 重投时由语义层透传 `job.resumeState`
     * ——信封为纯数据；首跑不传，worker 内 taskCtx.resumed 为 undefined）
     */
    resumed?: { state?: unknown; inject?: unknown; activations: number };
  };
  /** 单次执行超时（毫秒） */
  timeoutMs: number;
  /**
   * 取消宽限期（毫秒）——两段式取消第一段发出 abort 信号后等待任务自行退出的
   * 最长时间，超时未退出 `terminate()` 硬杀。来自 task meta `graceMs`，
   * 未声明用 `KILL_GRACE_MS`（5s）；`0` 表示不留宽限期（判定取消即硬杀）
   */
  graceMs?: number;
  /**
   * worker 线程 V8 老生代堆上限（MB）——透传 worker_threads
   * `resourceLimits.maxOldGenerationSizeMb`，超限 V8 终止线程（ERR_WORKER_OUT_OF_MEMORY
   * 经 error 事件 reject → 任务 failed，驱动按 retries 重试）。来自 task meta
   * `maxOldGenerationSizeMb`，未声明不传（worker 不设资源限制，与既有行为一致）
   */
  maxOldGenerationSizeMb?: number;
  /**
   * 注册表快照（纯数据，postMessage 结构化克隆传入，worker 内重建只读视图注入
   * taskCtx.registries）——语义层从 `TaskRegistriesView` 生成，缺省为空视图
   */
  registries?: TaskRegistriesSnapshot;
  /**
   * 任务日志配置（纯数据，postMessage 传入，worker 内联重建日志器注入 taskCtx.log；
   * 缺省时 taskCtx.log 为 undefined）：scope/fields 与进程内路径一致（`task:<name>`
   * + jobId/task/attempt），level 为宿主侧生效的全局级别（worker 侧预过滤，
   * 宿主 writeLogEntry 再次过滤；undefined = 宿主未配置阈值——文件管道默认全量，
   * worker 侧同样不过滤）
   */
  log?: { level?: LogLevel; scope?: string; fields?: Record<string, unknown> };
  /** 外部取消信号（驱动停机超时 abort）——abort 同样触发两段式取消 */
  externalSignal?: AbortSignal;
  /**
   * 进度回调：worker 内 `taskCtx.progress(value)` 的值经 `{ type: 'progress' }`
   * 消息回传宿主（语义层记入 `TaskJob.progress`）；不传则进度消息被忽略
   */
  onProgress?: (value: unknown) => void;
  /**
   * 事件回调：worker 内 `taskCtx.emit(data)` 的值经 `{ type: 'event' }` 消息回传
   * 宿主（语义层落事件缓冲 + 订阅扇出，见 taskEvents.md）；不传则事件消息被忽略。
   * 宽限期（取消判定后）到达的事件不采纳（超时判定即终局，与 progress 同口径）
   */
  onEvent?: (value: unknown) => void;
  /**
   * 日志回调：worker 内 taskCtx.log 的条目经 `{ type: 'log' }` 消息回传宿主，
   * 由语义层接 writeLogEntry 走统一管道（自定义 sink 同样覆盖隔离任务）；
   * 不传则日志条目被忽略。宽限期（取消判定后）到达的条目不采纳（超时判定即终局）
   */
  onLog?: (entry: LogEntry) => void;
  /**
   * 任务客户端 RPC 分派（worker 内 `taskCtx.tasks.*` 经 `{ type: 'tasks-call' }`
   * 消息回传宿主执行，结果/错误按 seq 回传）——语义层注入（闭包持有队列本体）；
   * 不传则 worker 内 taskCtx.tasks 的调用以错误拒绝（直接构造执行器的测试场景）
   */
  onTasksCall?: (method: string, args: unknown[]) => Promise<unknown>;
  /**
   * 挂起回调：worker 内 `taskCtx.suspend(state)` 经 `{ type: 'suspend' }` 消息
   * 回传宿主执行信封持久化（与进程内路径共用同一写入，语义层注入并落账
   * suspended）；不传则 worker 内 taskCtx.suspend 的调用以错误拒绝（直接构造
   * 执行器的测试场景，与 onTasksCall 同口径）。回调拒绝时错误原样回传 reject
   */
  onSuspend?: (state?: unknown) => Promise<void>;
  /**
   * agent 循环执行分派（worker 内 `taskCtx.agent.run` 经单次 `{ type: 'agent-run' }`
   * 消息回传宿主，宿主构造 Agent 跑完整编排循环，结果/错误按 seq 回传）——语义层
   * 注入（闭包持有 agentRunner 与任务合成契约 ctx）；不传则 run 消息不携带
   * `agentChannel`，worker 内 taskCtx.agent 不挂载（插件未加载，能力不存在）。
   * 请求与返回值须可结构化克隆（不可克隆按执行错误回传，与 tasks-call 同口径）。
   * 第二参为宿主侧取消控制器 signal（与 llm-complete 同款 per-call controller）——
   * 两段式取消第一段 abort：AgentRunner 合入 run options（宿主侧优先），循环抛
   * AgentAbortError 由语义层留痕 agent-aborted 事件
   */
  onAgentRun?: (request: AgentRunRequest, signal?: AbortSignal) => Promise<unknown>;
  /**
   * LLM 一次性补全分派（worker 内 `taskCtx.llm.complete` 经 `{ type: 'llm-complete' }`
   * 消息回传宿主执行——宿主从 AppRegistries.llm 取注册通道跑 LLM IO，结果/错误按
   * seq 回传）——语义层注入（闭包持有注册通道，派发时刻取值快照）；不传则 run 消息
   * 不携带 `llmChannel`，worker 内 taskCtx.llm 不挂载（通道未注册，能力不存在）。
   * 入参与返回值须可结构化克隆（signal 由执行器注入宿主侧 AbortController——worker
   * 侧业务级取消经 `{ type: 'llm-abort' }` 触发，任务取消（两段式）同样在第一段
   * abort 全部 in-flight 控制器；不可克隆按调用错误拒绝）
   */
  onLlmComplete?: (input: string, options?: Record<string, unknown>) => Promise<string>;
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

  return new Promise<unknown>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(resolveWorkerEntryUrl(), {
        workerData: {
          moduleUrl,
          resourcesDir: taskCtx.resourcesDir,
        } satisfies WorkerEntryData,
        // 堆上限透传（meta.maxOldGenerationSizeMb）：超限 V8 杀线程，error 事件
        // reject → 任务 failed；未声明不传——worker 不设资源限制
        ...(options.maxOldGenerationSizeMb !== undefined
          ? { resourceLimits: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb } }
          : {}),
      });
    } catch (err) {
      reject(err);
      return;
    }

    /** running →（超时/外部取消）grace →（宽限未退出 terminate）settled；settled 后一切事件忽略 */
    let phase: 'running' | 'grace' | 'settled' = 'running';
    let cancelReason = '';
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    /** agent-run 的宿主侧取消控制器（seq 映射；两段式取消第一段统一 abort） */
    const agentControllers = new Map<number, AbortController>();
    /** llm-complete 的宿主侧取消控制器（seq 映射；业务级 llm-abort 触发 abort） */
    const llmControllers = new Map<number, AbortController>();
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
      // 取消传播宿主：第一段即 abort 宿主侧全部 in-flight 控制器——agent-run 循环
      // 抛 AgentAbortError（messages 由语义层留痕 agent-aborted 事件）、llm-complete
      // IO 随任务取消中断（不白烧 tokens）。错误回传竞态无需处理：宽限期内到达的
      // RPC 结果照常回传（worker 可能仍在监听），任务终局已锁定不受影响
      for (const controller of agentControllers.values()) controller.abort();
      for (const controller of llmControllers.values()) controller.abort();
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
        seq?: number;
        method?: string;
        args?: unknown[];
        state?: unknown;
        agentName?: string;
        input?: string | Record<string, unknown>;
        options?: Record<string, unknown>;
      }) => {
        // taskCtx.tasks RPC：worker 内代理调用回传宿主执行（结果/错误按 seq 回传）。
        // running/grace 两阶段都处理——run 在宽限期内仍可能 await 一次入队；settled
        // 后 worker 已 terminate，不会再有消息
        if (msg?.type === 'tasks-call') {
          const { seq, method, args } = msg;
          const reply = (body: Record<string, unknown>) => {
            try {
              worker.postMessage({ type: 'tasks-result', seq, ...body });
            } catch (err) {
              // 回传值不可克隆：按调用错误回传（与 progress/log 同口径，不静默）
              try {
                worker.postMessage({
                  type: 'tasks-result',
                  seq,
                  ok: false,
                  error: {
                    name: 'Error',
                    message: `taskCtx.tasks.${method} result is not cloneable: ${String(err)}`,
                    stack: undefined,
                    props: {},
                  } satisfies SerializedWorkerError,
                });
              } catch {
                // 连错误负载都不可克隆（理论上不发生）——放弃回传，worker 侧按
                // 挂起处理并随超时终止
              }
            }
          };
          if (!options.onTasksCall) {
            reply({
              ok: false,
              error: {
                name: 'Error',
                message: `taskCtx.tasks.${method} is unavailable: no host handler was provided for this execution`,
                stack: undefined,
                props: {},
              } satisfies SerializedWorkerError,
            });
            return;
          }
          options
            .onTasksCall(method!, args ?? [])
            .then((value) => reply({ ok: true, value }))
            .catch((err: unknown) => {
              reply({
                ok: false,
                error: {
                  name: err instanceof Error ? err.name : 'Error',
                  message: err instanceof Error ? err.message : String(err),
                  stack: err instanceof Error ? err.stack : undefined,
                  props: {},
                } satisfies SerializedWorkerError,
              });
            });
          return;
        }
        if (msg?.type === 'agent-run') {
          // agent-run RPC：worker 内 taskCtx.agent.run 转发请求，宿主构造 Agent
          // 跑完整编排循环（单次 RPC 收敛——工具/钩子/sub-agent 全在宿主）。
          // running/grace 两阶段都处理（与 tasks-call 同口径——调用随任务超时两段式
          // 取消一并终止）；settled 后不会再有消息。signal 由宿主侧 AbortController
          // 注入（语义层经 AgentRunner 第三参 execution 合入 run options，宿主侧
          // 优先）——两段式取消第一段统一 abort，循环抛 AgentAbortError 由语义层
          // 留痕 agent-aborted 事件
          const { seq, agentName, input, options: runOptions } = msg;
          const request: AgentRunRequest = {
            agentName: agentName as string,
            ...(input !== undefined ? { input: input as string } : {}),
            ...(runOptions !== undefined ? { options: runOptions as Record<string, unknown> } : {}),
          };
          const controller = new AbortController();
          agentControllers.set(seq!, controller);
          const replyAgent = (body: Record<string, unknown>) => {
            try {
              worker.postMessage({ type: 'agent-run-result', seq, ...body });
            } catch (err) {
              // 回传值不可克隆：按执行错误回传（ReactLoopResult 须可结构化克隆——能力边界）
              try {
                worker.postMessage({
                  type: 'agent-run-result',
                  seq,
                  ok: false,
                  error: {
                    name: 'Error',
                    message:
                      'agent-run result is not cloneable across the worker boundary: ' +
                      `${String(err)}. The agent loop result must be plain data.`,
                    stack: undefined,
                    props: {},
                  } satisfies SerializedWorkerError,
                });
              } catch {
                // 连错误负载都不可克隆（理论上不发生）——放弃回传，worker 侧按挂起处理
              }
            }
          };
          if (!options.onAgentRun) {
            replyAgent({
              ok: false,
              error: {
                name: 'Error',
                message:
                  'taskCtx.agent.run is unavailable: no host handler was provided for this execution',
                stack: undefined,
                props: {},
              } satisfies SerializedWorkerError,
            });
            return;
          }
          options
            .onAgentRun(request, controller.signal)
            .then((value) => replyAgent({ ok: true, value }))
            .catch((err: unknown) => {
              replyAgent({
                ok: false,
                error: {
                  name: err instanceof Error ? err.name : 'Error',
                  message: err instanceof Error ? err.message : String(err),
                  stack: err instanceof Error ? err.stack : undefined,
                  props: {},
                } satisfies SerializedWorkerError,
              });
            })
            .finally(() => agentControllers.delete(seq!));
          return;
        }
        if (msg?.type === 'llm-complete') {
          // llm 一次性补全 RPC：worker 内 taskCtx.llm.complete 纯转发，宿主从
          // AppRegistries.llm 注册通道跑 LLM IO（worker 不加载 @faapi/agent）。
          // running/grace 两阶段都处理（与 tasks-call 同口径——调用随任务超时两段式
          // 取消一并终止）；settled 后不会再有消息。signal 由宿主侧 AbortController
          // 注入——两个 abort 源：worker 侧业务级取消经 llm-abort 触发；任务取消
          //（两段式）在第一段统一 abort（startCancel），LLM IO 不白烧 tokens
          const { seq, input, options: completeOptions } = msg;
          const controller = new AbortController();
          llmControllers.set(seq!, controller);
          const replyLlm = (body: Record<string, unknown>) => {
            try {
              worker.postMessage({ type: 'llm-result', seq, ...body });
            } catch (err) {
              // 回传值不可克隆（理论边缘——返回值恒字符串）：按调用错误回传
              try {
                worker.postMessage({
                  type: 'llm-result',
                  seq,
                  ok: false,
                  error: {
                    name: 'Error',
                    message: `taskCtx.llm.complete result is not cloneable: ${String(err)}`,
                    stack: undefined,
                    props: {},
                  } satisfies SerializedWorkerError,
                });
              } catch {
                // 连错误负载都不可克隆（理论上不发生）——放弃回传，worker 侧按挂起处理
              }
            }
          };
          if (!options.onLlmComplete) {
            replyLlm({
              ok: false,
              error: {
                name: 'Error',
                message:
                  'taskCtx.llm.complete is unavailable: no host handler was provided for this execution',
                stack: undefined,
                props: {},
              } satisfies SerializedWorkerError,
            });
            return;
          }
          options
            .onLlmComplete(input as string, {
              ...(completeOptions ?? {}),
              signal: controller.signal,
            })
            .then((value) => replyLlm({ ok: true, value }))
            .catch((err: unknown) => {
              replyLlm({
                ok: false,
                error: {
                  name: err instanceof Error ? err.name : 'Error',
                  message: err instanceof Error ? err.message : String(err),
                  stack: err instanceof Error ? err.stack : undefined,
                  props: {},
                } satisfies SerializedWorkerError,
              });
            })
            .finally(() => llmControllers.delete(seq!));
          return;
        }
        if (msg?.type === 'llm-abort') {
          // 业务级取消转发：worker 侧 AbortSignal abort → 宿主 abort 对应请求
          // （provider 层抛 AgentAbortError → llm-result ok:false 回传 reject）。
          // 未知/已完成 seq 静默忽略（abort 与完成竞态）
          llmControllers.get(msg.seq!)?.abort();
          return;
        }
        if (msg?.type === 'suspend') {
          // taskCtx.suspend RPC：worker 内挂起回传宿主执行信封持久化（与进程内
          // 路径共用同一写入，成功/失败按 seq 回传）。running/grace 两阶段都处理
          // （与 tasks-call 同口径——挂起调用随任务超时两段式取消一并终止）；
          // settled 后 worker 已 terminate，不会再有消息
          const { seq, state } = msg;
          const replySuspend = (body: Record<string, unknown>) => {
            try {
              worker.postMessage({ type: 'suspend-result', seq, ...body });
            } catch {
              // 错误负载不可克隆（理论上不发生）——放弃回传，worker 侧随超时终止
            }
          };
          if (!options.onSuspend) {
            replySuspend({
              ok: false,
              error: {
                name: 'Error',
                message:
                  'taskCtx.suspend is unavailable: no host handler was provided for this execution',
                stack: undefined,
                props: {},
              } satisfies SerializedWorkerError,
            });
            return;
          }
          options
            .onSuspend(state)
            .then(() => replySuspend({ ok: true }))
            .catch((err: unknown) => {
              replySuspend({
                ok: false,
                error: {
                  name: err instanceof Error ? err.name : 'Error',
                  message: err instanceof Error ? err.message : String(err),
                  stack: err instanceof Error ? err.stack : undefined,
                  props: {},
                } satisfies SerializedWorkerError,
              });
            });
          return;
        }
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
        } else if (msg?.type === 'event') {
          options.onEvent?.(msg.value);
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

    // taskCtx 含 job + config 纯数据快照（collectConfigSnapshot 投影，函数值不进
    // 快照，见 configSnapshot.md）+ carry 执行上下文快照（enqueue 时刻已校验纯数据）
    // + resumed 挂起/激活上下文（resume 重投时透传，信封为纯数据）；registries 为
    // 纯数据快照（缺省 undefined → worker 内空视图）postMessage 不可克隆时按错误处理
    try {
      worker.postMessage({
        type: 'run',
        payload,
        taskCtx: {
          job: taskCtx.job,
          ...(taskCtx.config !== undefined ? { config: taskCtx.config } : {}),
          ...(taskCtx.carry !== undefined ? { carry: taskCtx.carry } : {}),
          ...(taskCtx.resumed !== undefined ? { resumed: taskCtx.resumed } : {}),
        },
        registries: options.registries,
        log: options.log,
        // 隔离 llm 通道开关：onLlmComplete 已注入（AppRegistries.llm 已注册通道）
        // 才挂载 worker 内 taskCtx.llm——通道未注册时能力不存在，worker 不组装
        llmChannel: options.onLlmComplete !== undefined,
        // 隔离 agent 通道开关：onAgentRun 已注入（agentRunner 已注册）才挂载
        // worker 内 taskCtx.agent——插件未加载时能力不存在，worker 不组装
        agentChannel: options.onAgentRun !== undefined,
      });
    } catch (err) {
      finish(() =>
        reject(new Error(`Task "${taskCtx.job.name}" payload is not cloneable: ${String(err)}`)),
      );
    }
  });
}
