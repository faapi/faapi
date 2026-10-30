import type { TaskRegistry } from './taskRegistry';
import type { TaskDriver } from './driverTypes';
import type { TaskRegistriesView, LlmChannelStore } from '../injection/registries';
import type { LlmComplete } from '../injection/llmTypes';
import type { FaapiContextConfig } from '../runtime/contextTypes';
import type { Logger } from '../loggers/loggerTypes';

/**
 * 任务元信息（业务方在 `src/tasks/<name>/task.ts` 中 `export const task = {...}` 声明）。
 *
 * 不收 `timeoutMs` / `graceMs`：任务在进程内执行，deadline 由业务自行 `Promise.race`；
 * 队列系统执行硬限由驱动兜底（pgboss 走 defaultExpireSeconds，可按部署调整）。
 * 未声明字段时由运行时使用默认值（concurrency=1、retries=0、无 cron）。
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
 * 构建期扫描清单记录（scanTasks 产出，源码路径形式）
 */
export interface TaskManifest {
  /** 任务名：tasks/ 后目录路径段用 . 连接（如 `send-email`、`a.b`） */
  name: string;
  /** 源码相对路径（`src/tasks/<dir>/task.ts`） */
  filePath: string;
  cron?: string;
  concurrency?: number;
  retries?: number;
}

/**
 * 运行时任务元数据（faapi-tasks.js 水合到 TaskRegistry 后的形态，产物路径形式）
 */
export interface TaskMetadata {
  name: string;
  /** 产物路径（`<dist>/tasks/<dir>/task.js`），运行时 import 任务模块 */
  filePath: string;
  cron?: string;
  concurrency?: number;
  retries?: number;
}

/**
 * 任务记录状态
 *
 * cancelled = 执行被框架终止（停机取消——驱动 signal abort），区别于 run 自身抛错的 failed；
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
 * 任务被框架终止的标记错误（停机取消——驱动 signal abort 传播至 run 内部时业务
 * 可主动抛出）——runJob 据此把记录记为 `cancelled`（与 run 自身抛错的 `failed`
 * 分流）；`job.signal.aborted` 命中同口径。
 */
export class TaskCancelledError extends Error {
  constructor(message = 'Task was cancelled') {
    super(message);
    this.name = 'TaskCancelledError';
  }
}

/**
 * 组内成员落定的终态（TaskJobStatus 的终态子集——落定 = 最终终态，
 * 重试等待中的失败不算）
 */
export type TaskGroupOutcome = 'done' | 'failed' | 'cancelled';

/**
 * 批量级失败语义（enqueueSequence / enqueueBatch 声明）：
 * - 'run-to-completion'（默认）：成员最终失败不影响其余成员，回调照常在全部落定时触发
 * - 'fail-fast'：首个成员最终失败即终止——串行序列不再激活后续条目（未激活成员补记
 *   cancelled）；并行批次取消队列中未落定成员（在跑的自然跑完）
 */
export type TaskGroupOnFailure = 'fail-fast' | 'run-to-completion';

/**
 * 完成回调任务的 payload 契约（fan-in）——全部成员落定时框架以该形状入队
 * onComplete 任务（走 enqueue 同一 payload 校验通道，回调任务 Payload 声明须兼容，
 * 建议 `interface Payload extends TaskGroupSummary {}`）
 */
export interface TaskGroupSummary {
  /** 批量标识（业务关联键原样透传；存储层沿组记账通道，键名保留 groupId） */
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
 * 批量记账快照（getGroup 返回；驱动侧存储的实时投影；两形态共用，机制见 taskBatch.md）
 */
export interface TaskGroupSnapshot extends TaskGroupSummary {
  /** 完成回调任务名（未声明时无 fan-in，仅记账） */
  onComplete?: string;
  /** 批量级失败语义 */
  onFailure: TaskGroupOnFailure;
  /** 'settled' = 全部落定 */
  status: 'open' | 'settled';
  /** 完成回调是否已入队（false 且 status settled = 回调未入队——可经同 id 重投自愈） */
  completionEnqueued: boolean;
  /** 执行形态：'serial' 串行有序（enqueueSequence）| 'parallel' 并行无序（enqueueBatch） */
  execution: 'serial' | 'parallel';
  /**
   * 已推进的激活位置（仅 serial）：指向下一个可能需要（重新）入队的成员 0 基 index——
   * 正常推进时指向最新激活成员（重投 dedup 命中零开销），激活两步崩溃窗口指向断链
   * 成员（重投真补投）；全部落定时 = total
   */
  nextIndex?: number;
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
  /** 所属批量（enqueueSequence / enqueueBatch 的成员任务携带；非批量任务无此字段） */
  groupId?: string;
  /**
   * 批量内成员序号（0 基，串行序列的成员携带——激活入队时由框架传入，
   * 观测成员在序列中的位置；并行批次与任务级投递无此字段）
   */
  groupIndex?: number;
  /** enqueue 时携带的执行上下文快照（`opts.carry`；未传无此字段） */
  carry?: Record<string, unknown>;
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
 * 任务的 run 第二参数（`src/tasks/<name>/task.ts` 声明的任务）——任务在进程内
 * 执行，config 为活引用、registries 为活引用、模块级状态与宿主共享。
 */
export interface TaskContext {
  /** 优雅停机时对在跑任务 abort 的信号 */
  signal: AbortSignal;
  /**
   * 任务客户端（与 `ctx.tasks` / `app.tasks` 同一 app 实例队列）——任务内入队 /
   * 批量登记 / 查询不绕 `getApp()`。
   */
  tasks: TaskClient;
  /**
   * faapi.config.ts 全量配置（含自定义业务配置），类型经 `FaapiContextConfig`
   * 声明合并增强——与 handler `ctx.config` 同一类型、同一对象（活引用）。
   * 业务增强的类型字段全部可读，函数字段可调用。
   */
  config: FaapiContextConfig;
  job: { id: string; name: string; attempt: number };
  /**
   * app 注册表只读视图（agent/tool 元数据查询，不含 hydrate/clear 写接口）
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
   * 驱动未实现 `TaskDriver.taskState` 时显式抛错。完整语义见 taskSuspend.md。
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
  /**
   * enqueue 时携带的执行上下文快照（`enqueue/enqueueSequence/enqueueBatch` 的
   * `opts.carry`）——身份/标记等**纯数据**，随任务持久化
   * 跨实例/重启正确。任务内续投自动继承当前 carry（显式传 carry 覆盖）；
   * cron 触发为空对象。典型用途：HTTP 入队处声明执行身份
   * （`carry: { currentUserId: ctx.currentUserId }`），任务侧经
   * `taskCtx.carry` 或 `taskCtx.agent`（@faapi/agent 增强，惰性以 carry 为
   * 执行 ctx 构造）消费——身份在它天然存在的地方声明一次，队列只搬运。
   */
  carry: Record<string, unknown>;
}

/**
 * 任务模块形态（task.ts 编译产物中与执行相关的导出）
 */
export interface TaskModule {
  run?: (payload: unknown, taskCtx: TaskContext) => unknown;
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
    opts?: { delayMs?: number; dedupId?: string; carry?: Record<string, unknown> },
  ): Promise<{ id: string }>;
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
   * 并行无序批量投递：一次登记 N 个同构子任务并挂同一批量标识，全部成员立即入队
   * 并行执行（批量记账 / fan-in 完整语义见 taskBatch.md）
   *
   * - payloads 全量校验前置（任一失败整批不投递）；空数组抛错
   * - opts.batchId 缺省自动生成；同 id 幂等重投（成员 dedupId 自动派生
   *   `faapi-group:<batchId>:<index>`，替代业务自拼序号；长任务扇出建议 batchId
   *   从业务键派生——发起任务重试即天然补投自愈）
   * - opts.onComplete：全部成员落定时框架自动入队的回调任务名（payload =
   *   TaskGroupSummary 契约）；opts.onFailure：'fail-fast'（首个成员最终失败即取消
   *   余下未落定成员）| 'run-to-completion'（缺省）
   *
   * @returns batchId 与各成员任务 id
   * @throws 任务不存在 / payloads 为空 / payload 校验失败（ValidationError）/
   *   队列已停止 / 驱动未实现批量记账（TaskDriver.groups 缺失）
   */
  enqueueBatch(
    name: string,
    payloads: unknown[],
    opts?: {
      batchId?: string;
      onComplete?: string;
      onFailure?: TaskGroupOnFailure;
      delayMs?: number;
      carry?: Record<string, unknown>;
    },
  ): Promise<{ batchId: string; jobs: { id: string }[] }>;
  /**
   * 串行有序批量投递：一次登记 N 条已知 payload，框架保证严格串行——前一条到达
   * 终态（含重试耗尽）才激活下一条（完整语义见 taskBatch.md）
   *
   * - payloads 全量校验前置（任一失败整序列不登记）并持久化到驱动侧序列行
   *   （激活发生在任意实例/重启之后）；空数组抛错
   * - opts.sequenceId 缺省自动生成；同 id 幂等重投（首条 dedup 命中零开销 /
   *   激活两步崩溃窗口经 nextIndex 补投自愈；参数漂移抛错）
   * - opts.onComplete：全部成员落定时框架自动入队的回调任务名（payload =
   *   TaskGroupSummary 契约）；opts.onFailure：'fail-fast'（首个成员最终失败即终止，
   *   未激活成员补记 cancelled）| 'run-to-completion'（缺省——失败跳过继续）
   * - opts.delayMs 仅作用于首条入队；opts.carry 随序列声明持久化，每条激活入队注入
   *
   * @returns sequenceId 与首条成员任务 id（序列已落定的重投不再入队，无 id）
   * @throws 任务不存在 / payloads 为空 / payload 校验失败（ValidationError）/
   *   队列已停止 / 驱动未实现批量记账（TaskDriver.groups 缺失）
   */
  enqueueSequence(
    name: string,
    payloads: unknown[],
    opts?: {
      sequenceId?: string;
      onComplete?: string;
      onFailure?: TaskGroupOnFailure;
      delayMs?: number;
      carry?: Record<string, unknown>;
    },
  ): Promise<{ sequenceId: string; id?: string }>;
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
   * **进程内可用**：订阅是回调签名，仅本进程语义（
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
  /**
   * app 事件总线（`task:failed` 事件发射源）。
   * 缺省（裸 createTaskQueue 的测试/嵌入场景）不发射——能力边界，非降级
   */
  appEvents?: import('../events/appEventBus.js').AppEventBus;
  /** faapi.config.ts 全量配置——注入 TaskContext.config（必填：无配置文件传空对象） */
  config: FaapiContextConfig;
  /**
   * app 注册表只读视图（`createTaskRegistriesView`）——注入 TaskContext.registries；
   * 缺省为空视图（直接构造队列的测试/嵌入场景）
   */
  registries?: TaskRegistriesView;
  /**
   * 轻量 LLM 补全通道 store（AppRegistries.llm）——任务执行时刻惰性读取
   * （插件晚于队列构造注册，构造期快照会漏）；缺省 taskCtx.llm 恒 undefined
   */
  llm?: LlmChannelStore;
  /**
   * agent handle 工厂 store（AppRegistries.agentHandle）——`taskCtx.agent` 惰性
   * 通道的数据源（以 carry + 任务级能力合成的契约 ctx 构造，与 HTTP 请求链同一份
   * baseDeps）；缺省 taskCtx.agent 恒 undefined
   */
  agentHandle?: import('../injection/registries.js').AgentHandleStore;
  /**
   * 队列驱动（必填）：`loadTaskDriver` 解析结果（pgboss/bullmq 子包驱动）
   * 或自定义 TaskDriver 实例；无任务清单时由 createAppBase 传入 idleTaskDriver
   */
  driver: TaskDriver;
  /** 任务模块加载器（默认：import 产物路径） */
  loadTaskModule?: (filePath: string) => Promise<TaskModule>;
  /** payload schema 加载器（默认：import 任务目录 zod.js，取首个 `*Schema` 导出） */
  loadPayloadSchema?: (filePath: string) => Promise<unknown>;
}

/**
 * 任务失败信息（`task:failed` 事件载荷）
 *
 * willRetry 按任务 meta.retries 推算（attempt <= retries 时驱动会重试）；
 * cancelled = 执行被框架终止（停机取消），与 run 自身失败区分。
 */
export interface TaskFailedInfo {
  task: string;
  jobId: string;
  attempt: number;
  willRetry: boolean;
  cancelled: boolean;
  error: string;
}
