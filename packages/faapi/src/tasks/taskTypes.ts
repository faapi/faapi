import type { ToolMetadata } from '../ast/extractToolMetadata';
import type { AgentMetadata, AgentCore } from '../ast/extractAgentMetadata';
import type { TaskRegistry } from './taskRegistry';
import type { TaskDriver } from './driverTypes';
import type { TaskWorkerRunner } from './taskWorker';
import type { TaskRegistriesView, LlmChannelStore } from '../injection/registries';
import type { LlmComplete } from '../injection/llmTypes';
import type { LlmConfig } from '../configs/configTypes';
import type { FaapiContextConfig } from '../runtime/contextTypes';
import type { Logger } from '../loggers/loggerTypes';

/**
 * 进程内任务元信息（业务方在 `src/tasks/<name>/task.ts` 中 `export const task = {...}` 声明）。
 *
 * 不收 `timeoutMs` / `graceMs`：执行路径由声明文件种类决定（task.ts 进程内 / worker.ts 隔离），
 * 不再由超时字段隐式判定——进程内任务声明超时字段构建期报错（scanTasks 校验，附迁移指引）。
 * 进程内 deadline 由业务自行 `Promise.race`。未声明字段时由运行时使用默认值
 * （concurrency=1、retries=0、无 cron）。
 */
export interface FaapiTaskMeta {
  /** 同名任务的最大并行执行数（默认 1） */
  concurrency?: number;
  /** 失败重试次数（默认 0——失败即 failed，不重试） */
  retries?: number;
  /** cron 表达式（croner 语法，支持秒级）——到点自动入队空 payload */
  cron?: string;
}

/**
 * 隔离任务元信息（业务方在 `src/tasks/<name>/worker.ts` 中 `export const task = {...}` 声明）。
 *
 * 隔离任务在独立 worker 线程执行，具备真终止取消（见 taskWorker.ts 文档头）。
 * `timeoutMs` 必填：隔离语义即"需要真取消的长任务"，执行预算显式声明。
 *
 * 所有声明字段与 FaapiTaskMeta 同款字面量约定（零 import 扫描，数字字段支持下划线分隔）。
 */
export interface FaapiWorkerTaskMeta {
  /**
   * 执行超时（毫秒，必填，最小 60000 即 1 分钟、最大 82800000 即 23h——越界在扫描期报错）。
   * 超时两段式取消（先 abort 信号宽限，未退出 terminate 硬杀）——判定超时即执行真正终止。
   * 超时从派发起算，包含 worker 冷启动（线程创建 + 模块加载）。
   */
  timeoutMs: number;
  /**
   * 取消宽限期（毫秒，仅隔离任务生效）：两段式取消第一段发出 abort 信号后等待任务
   * 自行退出的最长时间，超时未退出 `terminate()` 硬杀。默认 5000（5s）；`0` 表示不留
   * 宽限期（判定取消即硬杀）。
   */
  graceMs?: number;
  /** 同名任务的最大并行执行数（默认 1） */
  concurrency?: number;
  /** 失败重试次数（默认 0——失败即 failed，不重试） */
  retries?: number;
  /** cron 表达式（croner 语法，支持秒级）——到点自动入队空 payload */
  cron?: string;
}

/**
 * 构建期扫描清单记录（scanTasks 产出，源码路径形式）
 */
export interface TaskManifest {
  /** 任务名：tasks/ 后目录路径段用 . 连接（如 `send-email`、`a.b`） */
  name: string;
  /** 源码相对路径（`src/tasks/<dir>/task.ts` 或 `src/tasks/<dir>/worker.ts`） */
  filePath: string;
  /** 执行模式：由声明文件种类决定（task.ts → inline，worker.ts → isolated） */
  mode: 'inline' | 'isolated';
  cron?: string;
  concurrency?: number;
  retries?: number;
  /** 隔离任务执行预算（FaapiWorkerTaskMeta 必填；进程内任务无此字段） */
  timeoutMs?: number;
  /** 隔离任务取消宽限期 */
  graceMs?: number;
}

/**
 * 运行时任务元数据（faapi-tasks.js 水合到 TaskRegistry 后的形态，产物路径形式）
 */
export interface TaskMetadata {
  name: string;
  /** 产物路径（`<dist>/tasks/<dir>/task.js` / `<dist>/tasks/<dir>/worker.js`），运行时 import 任务模块 */
  filePath: string;
  /** 执行模式（清单序列化保留），运行时执行路径判据 */
  mode: 'inline' | 'isolated';
  cron?: string;
  concurrency?: number;
  retries?: number;
  /** 隔离任务执行预算（mode 为 isolated 时必有，scanTasks 构建期保证） */
  timeoutMs?: number;
  /** 取消宽限期（毫秒，仅隔离任务生效），未声明用框架默认 5s */
  graceMs?: number;
}

/**
 * 任务记录状态
 *
 * cancelled = 执行被框架终止（超时两段式取消 / 停机取消），区别于 run 自身抛错的 failed；
 * 驱动重试时记录回到 running 继续流转。
 * suspended = 任务挂起等激活（`taskCtx.suspend` 暂存状态后执行体已释放，非终态
 * 也不在跑——计入单飞活跃判定，激活用 `tasks.resume`，见 taskSuspend.md）。
 */
export type TaskJobStatus =
  | 'pending'
  | 'running'
  | 'retry'
  | 'suspended'
  | 'done'
  | 'failed'
  | 'cancelled';

/**
 * 组内成员落定的终态（TaskJobStatus 的终态子集——落定 = 最终终态，
 * 重试等待中的失败不算）
 */
export type TaskGroupOutcome = 'done' | 'failed' | 'cancelled';

/**
 * 组级失败语义（enqueueGroup 声明）：
 * - 'run-to-completion'（默认）：成员最终失败不影响其余成员，回调照常在全部落定时触发
 * - 'fail-fast'：首个成员最终失败即取消组内未落定成员（在跑的自然跑完），取消成员落定 cancelled
 */
export type TaskGroupOnFailure = 'fail-fast' | 'run-to-completion';

/**
 * 完成回调任务的 payload 契约（fan-in）——全部成员落定时框架以该形状入队
 * onComplete 任务（走 enqueue 同一 payload 校验通道，回调任务 Payload 声明须兼容，
 * 建议 `interface Payload extends TaskGroupSummary {}`）
 */
export interface TaskGroupSummary {
  /** 组标识（业务关联键原样透传） */
  groupId: string;
  /** 成员任务名 */
  task: string;
  /** 成员总数 */
  total: number;
  /** 按最终终态分桶计数 */
  done: number;
  failed: number;
  cancelled: number;
  /** 已落定数（done + failed + cancelled） */
  settled: number;
}

/**
 * 组记账快照（getGroup 返回；驱动侧存储的实时投影）
 */
export interface TaskGroupSnapshot extends TaskGroupSummary {
  /** 完成回调任务名（未声明时无 fan-in，仅记账） */
  onComplete?: string;
  /** 组级失败语义 */
  onFailure: TaskGroupOnFailure;
  /** 'settled' = 全部落定 */
  status: 'open' | 'settled';
  /** 完成回调是否已入队（false 且 status settled = 回调未入队——可经同 groupId 重投自愈） */
  completionEnqueued: boolean;
}

/**
 * 任务执行记录（内存快照）
 */
export interface TaskJob {
  id: string;
  name: string;
  payload: unknown;
  status: TaskJobStatus;
  /** 已执行次数（含当前正在执行的一次） */
  attempts: number;
  /** run 的返回值（done 时） */
  result?: unknown;
  /** 错误消息（failed 时） */
  error?: string;
  /** 最近一次进度上报值（run 内 `taskCtx.progress(value)` 写入；派发时清空上一轮） */
  progress?: unknown;
  /** 所属任务组（组投递的成员任务携带；非组任务无此字段） */
  groupId?: string;
  /** 所属链（链式投递的任务携带；chainKey 键控单飞语义见 taskChain.md） */
  chainKey?: string;
  createdAt: number;
  /** 计划执行时间戳（重试/延迟任务与 createdAt 不同） */
  runAt?: number;
}

/**
 * 任务事件记录（`taskCtx.emit(data)` 落账后的宿主侧统一形态）
 *
 * 完整契约（订阅/查询/保留边界/取消口径）见 taskEvents.md。
 */
export interface TaskEvent {
  /** 任务名 */
  task: string;
  /** 任务执行 id（TaskJob.id） */
  jobId: string;
  /** 第几次执行（含重试，从 1 起） */
  attempt: number;
  /** 事件序号：单任务执行内从 1 起单调递增，跨 attempt 连续（重试不清零——过程历史） */
  seq: number;
  /** 宿主侧落账时间戳（毫秒） */
  at: number;
  /** 业务事件数据（emit 入参原样透传，形状是业务知识，框架不规定不校验） */
  data: unknown;
}

/**
 * 隔离执行跨线程传递的注册表快照（纯数据，结构化克隆安全）
 *
 * 注册表对象含函数闭包不可 postMessage；元数据本身是纯数据——语义层从
 * `TaskRegistriesView` 生成快照，worker wrapper 内重建只读视图。
 */
export interface TaskRegistriesSnapshot {
  /** agent 完整元数据（含 filePath，非仅 LLM 可见字段） */
  agents: AgentMetadata[];
  tools: ToolMetadata[];
  skills: AgentCore[];
}

/**
 * 进程内任务的 run 第二参数（`src/tasks/<name>/task.ts` 声明的任务）
 *
 * 与 {@link IsolatedTaskContext} 显式分开：两条执行路径的行为差异是实质性的
 * （config 有无、registries 活引用 vs 快照、模块级状态共享 vs 独立、取消语义），
 * 由声明文件种类决定（task.ts 进程内 / worker.ts 隔离，见 {@link FaapiTaskMeta}）——
 * 业务按路径标注对应类型，边界编译期可见；标注与文件种类不符构建期报错
 * （generateTaskArtifacts AST 校验）。
 */
export interface TaskContext {
  /** 优雅停机时对在跑任务 abort 的信号 */
  signal: AbortSignal;
  /**
   * 任务客户端（与 `ctx.tasks` / `app.tasks` 同一 app 实例队列）——任务内入队 /
   * 组投递 / 查询不绕 `getApp()`。隔离路径为 postMessage RPC 代理（语义一致，
   * 参数与返回值须可结构化克隆）
   */
  tasks: TaskClient;
  /**
   * faapi.config.ts 全量配置（含自定义业务配置），类型经 `FaapiContextConfig`
   * 声明合并增强——与 handler `ctx.config` 同一类型、同一对象（活引用）。
   * 业务增强的类型字段全部可读，函数字段可调用（同进程）。
   *
   * 隔离任务（`worker.ts` 声明）的 {@link IsolatedTaskContext.config} 为派发
   * 时刻的纯数据快照（函数字段不进快照——宿主回调面不跨线程，见 configSnapshot.md）。
   */
  config: FaapiContextConfig;
  job: { id: string; name: string; attempt: number };
  /**
   * app 注册表只读视图（agent/tool/skill 元数据查询，不含 hydrate/clear 写接口）
   *
   * 活引用（`createAppBase` 创建队列时传入）——反映注册表实时状态。
   * 任务内组装 agent 用 `registries.agent.getAgentEntry(name)`（含 filePath）。
   */
  registries: TaskRegistriesView;
  /**
   * 进度上报（可选）：执行中主动上报进度，直写本进程任务记录
   * （`TaskJob.progress`，`list()` 可见）。仅 running 状态生效，终态后调用被忽略。
   */
  progress?: (value: unknown) => void;
  /**
   * 任务事件出口（可选）：执行中发射过程事件（agent 流式 chunk、阶段标记等），
   * 落本进程事件缓冲并实时扇出订阅者（`TaskClient.subscribe` / `listEvents` 消费）。
   * 仅 running 状态生效，终态后调用被忽略（与 progress 同口径）。
   * 与 progress 的差异：progress 是单值覆盖槽（派发清空），事件是过程历史
   * （seq 跨 attempt 连续、重试不清）。完整契约见 taskEvents.md。
   */
  emit?: (data: unknown) => void;
  /**
   * 任务挂起（可选）：暂存状态并释放执行体——state 连同原 payload 以信封持久化
   * 到驱动 `taskState` 存储，任务记录转 `suspended`，run 正常返回（驱动照常
   * complete）。挂起后本任务的后续代码仍执行到 return，但结果不入 `result`、
   * 组记账不落定。激活用 `tasks.resume`（state 经 `taskCtx.resumed` 回传）。
   * 隔离任务（IsolatedTaskContext.suspend）语义零差——经 RPC 回传宿主执行同一
   * 信封写入。驱动未实现 `TaskDriver.taskState` 时显式抛错。完整语义见 taskSuspend.md。
   */
  suspend?: (state?: unknown) => Promise<void>;
  /**
   * 挂起/激活上下文（可选）：首跑为 `undefined`；经 `tasks.resume` 激活的执行
   * 携带 `{ state, inject?, activations }`——`state` 为挂起时暂存值，`inject` 为
   * 本次激活注入的附加数据，`activations` 为第几次激活（从 1 起）。
   */
  resumed?: { state?: unknown; inject?: unknown; activations: number };
  /**
   * 任务级日志器（可选字段；框架注入，直接构造 TaskContext 的测试/自定义执行器
   * 可不传）——scope `task:<name>`，字段自动携带 jobId/task/attempt，直写
   * `config.log` 全局管道（详见 logger/logger.md）。
   */
  log?: Logger;
  /**
   * 轻量 LLM 补全通道（可选字段；`@faapi/agent` 插件加载且 `agent.llms` 可解析时注入）
   *
   * `registries.llm` 的活引用（与 agent 循环共享 providers 单例）。
   * 一次性补全（分类/蒸馏/摘要等）用此通道，不必在任务内组装 agent；
   * 工具循环场景仍走 registries.agent 组装 Agent。详见 `@faapi/agent` 的 lightComplete.md。
   */
  llm?: LlmComplete;
}

/**
 * 隔离任务的 run 第二参数（`src/tasks/<name>/worker.ts` 声明的任务——独立 worker 线程执行）
 *
 * 与进程内 {@link TaskContext} 显式分开，差异由隔离语义决定：
 * - config 为派发时刻的**纯数据快照**（collectConfigSnapshot 投影——函数值不进
 *   快照（lifecycle 钩子/`task.onFailed`/log sink/middlewares 等宿主行为面不跨
 *   线程，与 registries 快照同款边界），其余值 structuredClone 保真；含非函数
 *   不可克隆值时派发显式报错列路径。见 configSnapshot.md）
 * - registries 为派发时刻的**快照**重建视图（执行中途 reload 不影响当次执行）
 * - llm 为 worker 内按 `agent.llms` 纯数据快照重建的实例
 * - log 条目经 postMessage 回传宿主统一输出（fields 须可结构化克隆，
 *   不可克隆按执行错误处理）
 * - progress 值经 postMessage 回传（须可结构化克隆，不可克隆按执行错误处理）
 * - emit 事件值经 postMessage 回传（须可结构化克隆，不可克隆按执行错误处理；
 *   取消判定后到达的事件不采纳——与 progress 同口径）
 * - suspend 经 RPC 回传宿主执行同一信封写入（语义与进程内零差，state 须可克隆）；
 *   resumed 随 run 消息透传（信封为纯数据）
 * - 模块级状态每次执行独立；取消为两段式真终止（abort 宽限 → terminate 硬杀）
 */
export interface IsolatedTaskContext {
  /** 优雅停机时对在跑任务 abort 的信号（abort 后宽限期内未退出 terminate 硬杀） */
  signal: AbortSignal;
  /**
   * 任务客户端代理——全方法经 postMessage RPC 回传宿主执行（宿主走完整 enqueue
   * 通道：存在性检查 + payload 校验 + 驱动入队 + 本地记录），与进程内路径零语义差；
   * **参数与返回值须可结构化克隆**（不可克隆按执行错误处理，与 progress/log 同口径）；
   * 挂起的调用随任务超时两段式取消一并终止，无独立超时
   */
  tasks: TaskClient;
  job: { id: string; name: string; attempt: number };
  /**
   * 进程配置的**纯数据快照**（必有；框架随 run 消息下发）——派发时刻由
   * `collectConfigSnapshot` 投影：函数值（lifecycle 钩子/`task.onFailed`/log
   * sink/middlewares 等宿主行为面）与 symbol 值不进快照（与 registries 快照
   * 同款能力边界），其余值 structuredClone 保真（Date/Map/Set 原样）；含非函数
   * 不可克隆值时任务派发即显式失败（错误列出路径）。读数据字段（端口/驱动选项/
   * llms/业务自定义段）无需 payload 手工搬运。见 configSnapshot.md。
   */
  config: FaapiContextConfig;
  /**
   * app 注册表只读视图——**派发时刻的快照**在 worker 内重建（宿主生成
   * `TaskRegistriesSnapshot` 纯数据随 postMessage 传入），查询方法与活引用
   * 视图同型；执行中途的 reload/DB skill 变更不影响当次执行。
   */
  registries: TaskRegistriesView;
  /**
   * 进度上报（可选）：值经 postMessage 回传宿主写入任务记录——**值必须可
   * 结构化克隆**，不可克隆按执行错误处理。仅 running 状态生效；取消判定后
   * （宽限期内）到达的上报忽略。
   */
  progress?: (value: unknown) => void;
  /**
   * 任务事件出口（可选）：值经 postMessage 回传宿主落事件缓冲并扇出订阅者
   * （`TaskClient.subscribe` / `listEvents` 消费）——**值必须可结构化克隆**，
   * 不可克隆按执行错误处理（与 progress 同口径）。仅 running 状态生效；取消
   * 判定后（宽限期内）到达的事件不采纳。完整契约见 taskEvents.md。
   */
  emit?: (data: unknown) => void;
  /**
   * 任务挂起（可选）：与进程内 {@link TaskContext.suspend} **语义零差**——经
   * `{ type: 'suspend' }` 消息 RPC 回传宿主执行同一信封写入（`driver.taskState`），
   * 任务记录转 `suspended`、run 正常返回；宿主拒绝（驱动无 `taskState` 等）
   * 错误原样 reject。**state 须可结构化克隆**（不可克隆按执行错误处理，与
   * progress/log 同口径）；挂起的 RPC 调用随任务超时两段式取消一并终止。
   * 完整语义见 taskSuspend.md。
   */
  suspend?: (state?: unknown) => Promise<void>;
  /**
   * 挂起/激活上下文（可选）：与进程内同语义——首跑为 `undefined`；经
   * `tasks.resume` 激活的执行携带 `{ state, inject?, activations }`（信封为
   * 纯数据，随 run 消息透传）。
   */
  resumed?: { state?: unknown; inject?: unknown; activations: number };
  /**
   * 任务级日志器（可选字段；框架注入）——scope `task:<name>`，条目经 postMessage
   * 回传宿主走 `config.log` 统一管道；**fields 须可结构化克隆**（不可克隆按
   * 执行错误处理，与 progress 同语义）。
   */
  log?: Logger;
  /**
   * 轻量 LLM 补全通道（可选字段）——worker 内按 `agent.llms` 纯数据快照动态
   * 加载 `@faapi/agent` 重建；llms 已配置但不可解析时任务显式失败（含安装指引），
   * llms 未配置时为 `undefined`（能力不存在，非降级）。
   * 详见 `@faapi/agent` 的 lightComplete.md。
   */
  llm?: LlmComplete;
}

/**
 * 进程内任务模块形态（task.ts 编译产物中与执行相关的导出）
 *
 * run 第二参数类型为进程内 {@link TaskContext}；隔离任务（worker.ts 声明）的
 * 模块形态见 {@link IsolatedTaskModule}——两种声明 API 的 run 签名分别对应，
 * ctx 标注与文件种类不符构建期报错（generateTaskArtifacts AST 校验）。
 */
export interface TaskModule {
  run?: (payload: unknown, taskCtx: TaskContext) => unknown;
}

/**
 * 隔离任务模块形态（worker.ts 编译产物中与执行相关的导出）
 *
 * run 第二参数类型为隔离 {@link IsolatedTaskContext}（config 为派发时刻纯数据
 * 快照，见 configSnapshot.md），标注与文件种类不符构建期报错。
 */
export interface IsolatedTaskModule {
  run?: (payload: unknown, taskCtx: IsolatedTaskContext) => unknown;
}

/**
 * 任务触发客户端（`tasks` 注入参数 / `ctx.tasks` / `app.tasks` 共用）
 */
export interface TaskClient {
  /**
   * 入队一个任务
   *
   * @param opts.dedupId 幂等键（可选）——同键任务在队列系统保留期内不重复入队，
   *   重复投递返回已存在任务 id（驱动语义见 driverTypes.md）；cron 投递自动携带
   * @returns 任务 id
   * @throws 任务不存在 / 队列已停止 / payload 校验失败（ValidationError）
   */
  enqueue(
    name: string,
    payload?: unknown,
    opts?: { delayMs?: number; dedupId?: string },
  ): Promise<{ id: string }>;
  /**
   * 链式投递：chainKey 键控单飞（同键至多一条活跃任务），无活跃才入队（完整
   * 语义见 taskChain.md）
   *
   * - opts.chainKey 必填非空字符串——业务关联键（如 `deconstruct:<novelId>`），
   *   活跃查证按键过滤，不依赖 payload 形状
   * - 活跃（pending/running/retry）同键任务存在 → 不投，返回活跃任务现状；
   *   无活跃 → 入队（dedupId 框架托管 `faapi-chain:<chainKey>:<时间戳>`，终态后
   *   可重投），返回新任务 id
   * - opts.excludeJobId：活跃查证时跳过的 job id——任务执行路径（taskCtx.tasks）
   *   自动注入为调用方自身（任务内自续投不被自身 running 态挡住），非任务上下文
   *   调用无需手传
   *
   * @returns enqueued=false 时附带活跃任务 jobId/status；enqueued=true 时附带新任务 id
   * @throws 任务不存在 / chainKey 缺失或空白 / 队列已停止 / payload 校验失败
   *   （ValidationError）/ 驱动未实现 TaskDriver.list（活跃查证能力边界，
   *   与 listQueued 同口径）
   */
  enqueueChain(
    name: string,
    payload?: unknown,
    opts?: { chainKey: string; delayMs?: number; excludeJobId?: string },
  ): Promise<
    { enqueued: true; id: string } | { enqueued: false; jobId: string; status: TaskJobStatus }
  >;
  /** 任务记录快照（可按任务名过滤）——本进程内存活记录，不含其他实例/重启前历史 */
  list(name?: string): TaskJob[];
  /**
   * 持久化队列视图：驱动实现 `TaskDriver.list` 时返回队列侧任务（含其他实例的
   * 与历史执行），并与本进程记录按 id 合并（本进程观测优先：status/attempts/
   * result/error 以本进程为准）
   *
   * @throws 驱动未实现 TaskDriver.list（能力边界见 driverTypes.md——pgboss 未实现，
   * 用 pg-boss 自身 API/SQL 旁路；BullMQ 全支持）
   */
  listQueued(name?: string): Promise<TaskJob[]>;
  /**
   * 取消队列侧任务：等待/延迟中的不再执行（语义随驱动——pgboss 保留 cancelled
   * 记录，bullmq 为 job.remove 即移除）
   *
   * @throws 驱动未实现 TaskDriver.cancel
   */
  cancel(name: string, id: string): Promise<void>;
  /**
   * 重试队列侧失败/取消的任务（pgboss 仅 cancelled 可 resume；bullmq 仅 failed
   * 可 retry；任务不存在/状态不允许由驱动抛错）
   *
   * @throws 驱动未实现 TaskDriver.retry
   */
  retry(name: string, id: string): Promise<void>;
  /**
   * 组投递：一次投递 N 个同构子任务并挂同一组标识（组投递 / 记账 / fan-in 完整
   * 语义见 taskGroups.md）
   *
   * - payloads 全量校验前置（任一失败整组不投递）；空数组抛错
   * - opts.groupId 缺省自动生成；同 id 幂等重投（成员 dedupId 自动派生
   *   `faapi-group:<groupId>:<index>`，替代业务自拼序号；长任务扇出建议 groupId
   *   从业务键派生——发起任务重试即天然补投自愈）
   * - opts.onComplete：全部成员落定时框架自动入队的回调任务名（payload =
   *   TaskGroupSummary 契约）；opts.onFailure：'fail-fast' | 'run-to-completion'
   *   （缺省后者）
   *
   * @returns groupId 与各成员任务 id
   * @throws 任务不存在 / payloads 为空 / payload 校验失败（ValidationError）/
   *   队列已停止 / 驱动未实现组记账（TaskDriver.groups 缺失）
   */
  enqueueGroup(
    name: string,
    payloads: unknown[],
    opts?: {
      groupId?: string;
      onComplete?: string;
      onFailure?: TaskGroupOnFailure;
      delayMs?: number;
    },
  ): Promise<{ groupId: string; jobs: { id: string }[] }>;
  /**
   * 组记账快照（计数器为驱动侧存储的实时投影——跨实例/重启正确）
   *
   * @returns 组不存在返回 undefined
   * @throws 驱动未实现组记账（TaskDriver.groups 缺失）
   */
  getGroup(groupId: string): Promise<TaskGroupSnapshot | undefined>;
  /**
   * 激活挂起的任务：读取挂起信封（原 payload + state）→ 删除信封 → 以原 payload
   * 重新入队（新执行周期：attempt 从 1 重新计数）→ 续跑执行经 `taskCtx.resumed`
   * 拿到 `{ state, inject?, activations }`。原挂起记录转 done（该挂起周期终结）。
   * 完整语义见 taskSuspend.md。
   *
   * @param opts.inject 本次激活注入的附加数据（审批意见等），随 `taskCtx.resumed` 回传
   * @returns 新执行的任务 id
   * @throws 任务不存在 / 任务非 suspended 状态 / 信封缺失 / 队列已停止 /
   *   驱动未实现 TaskDriver.taskState
   */
  resume(name: string, jobId: string, opts?: { inject?: unknown }): Promise<{ id: string }>;
  /**
   * 任务事件实时订阅（本进程）：该任务名后续每次 `taskCtx.emit` 落账后同步回调
   * （匹配所有执行/所有 attempt）。**不回放订阅前历史**（补历史用 listEvents）；
   * 返回退订函数。handler 抛错 console.error 留痕——不影响任务执行与其他订阅者。
   *
   * **仅宿主侧可用**：隔离任务 `taskCtx.tasks.subscribe` 显式抛错（回调函数不可
   * 结构化克隆跨线程）；进程内任务为活引用可直调，但订阅面向管理面/桥接。
   * 完整契约见 taskEvents.md。
   */
  subscribe(name: string, handler: (event: TaskEvent) => void): () => void;
  /**
   * 任务事件查询（本进程有界保留）：按任务名过滤，`opts.jobId` 收窄到单次执行，
   * seq 升序返回。事件生命周期与任务记录绑定（记录终态淘汰时事件一并清理），
   * 驱动无关（本进程内存观测面，不持久化、不跨实例）。完整契约见 taskEvents.md。
   */
  listEvents(name: string, opts?: { jobId?: string }): TaskEvent[];
}

/**
 * 任务队列（TaskClient + 生命周期控制，createAppBase 内部使用）
 */
export interface TaskQueue extends TaskClient {
  /** 开始派发（幂等） */
  start(): void;
  /** 停止接受新任务并等待在跑任务完成（超时 abort），幂等 */
  stop(timeoutMs?: number): Promise<void>;
  /** 重注册 worker（dev reloadTasks 用——驱动连接保持，仅按最新注册表重建消费） */
  reload(): Promise<void>;
  /** 清空任务模块缓存（dev reloadTasks 用） */
  invalidateModules(): void;
  /** 清空 payload schema 缓存（dev reloadTasks 用） */
  invalidateSchemas(): void;
}

/** 队列依赖（测试可注入自定义加载器/驱动） */
export interface TaskQueueDeps {
  registry: TaskRegistry;
  rootDir: string;
  /** faapi.config.ts 全量配置——注入进程内路径的 TaskContext.config（必填：无配置文件传空对象；隔离任务不传 config） */
  config: FaapiContextConfig;
  /**
   * 产物 resources 目录绝对路径——**内部字段**，仅作隔离 worker 读取根播种的
   * 数据源（经 workerData 传入 workerEntry，不进业务可见的 TaskContext——
   * 任务读资源统一走免传参 `readResource`）；缺省不播种（直接构造队列的
   * 测试/嵌入场景，readResource 未绑定即显式抛错）
   */
  resourcesDir?: string;
  /**
   * app 注册表只读视图（`createTaskRegistriesView`）——注入两条执行路径的
   * TaskContext.registries；缺省为空视图（直接构造队列的测试/嵌入场景）
   */
  registries?: TaskRegistriesView;
  /**
   * 轻量 LLM 补全通道 store（AppRegistries.llm）——进程内执行路径在任务执行时刻
   * 惰性读取（插件晚于队列构造注册，构造期快照会漏）；缺省 taskCtx.llm 恒 undefined
   */
  llm?: LlmChannelStore;
  /**
   * `agent.llms` 纯数据快照——隔离执行路径经 postMessage 传入 worker，worker 内
   * 动态加载 `@faapi/agent` 重建补全通道（纯数据可结构化克隆）。缺省不传入
   * （worker 内 taskCtx.llm 为 undefined）
   */
  llms?: Record<string, LlmConfig>;
  /**
   * 队列驱动（必填）：`loadTaskDriver` 解析结果（pgboss/bullmq 子包驱动）
   * 或自定义 TaskDriver 实例；无任务清单时由 createAppBase 传入 idleTaskDriver
   */
  driver: TaskDriver;
  /** 任务模块加载器（默认：import 产物路径） */
  loadTaskModule?: (filePath: string) => Promise<TaskModule>;
  /** payload schema 加载器（默认：import 任务目录 zod.js，取首个 `*Schema` 导出） */
  loadPayloadSchema?: (filePath: string) => Promise<unknown>;
  /**
   * 隔离执行器（默认 runTaskInWorker）——任务 mode 为 isolated（worker.ts 声明）时
   * 由语义层调用，独立 worker 线程执行 + 超时两段式取消；测试注入 spy 验证执行路径路由
   */
  runIsolated?: TaskWorkerRunner;
  /**
   * 执行失败/取消钩子（config.task.onFailed）——每次 process 抛错后触发
   * （含将重试的失败）；用于告警/死信上报等副作用，自身抛错被忽略
   */
  onFailed?: TaskFailedHandler;
}

/**
 * 任务失败信息（onFailed 钩子参数）
 *
 * willRetry 按任务 meta.retries 推算（attempt <= retries 时驱动会重试）；
 * cancelled = 执行被框架终止（超时终止/停机取消），与 run 自身失败区分。
 */
export interface TaskFailedInfo {
  task: string;
  jobId: string;
  attempt: number;
  willRetry: boolean;
  cancelled: boolean;
  error: string;
}

export type TaskFailedHandler = (info: TaskFailedInfo) => Promise<void> | void;
