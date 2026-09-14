import type { ToolMetadata } from '../ast/extractToolMetadata';
import type { AgentMetadata, AgentCore } from '../ast/extractAgentMetadata';
import type { TaskRegistry } from './taskRegistry';
import type { TaskDriver } from './driverTypes';
import type { TaskWorkerRunner } from './taskWorker';
import type { TaskRegistriesView } from '../injection/registries';

/**
 * 任务元信息（业务方在 task.ts 中 `export const task = {...}` 声明）
 *
 * 所有字段可选；未声明时由运行时使用默认值（concurrency=1、retries=0、无 cron）。
 */
export interface FaapiTaskMeta {
  /** 同名任务的最大并行执行数（默认 1） */
  concurrency?: number;
  /** 失败重试次数（默认 0——失败即 failed，不重试） */
  retries?: number;
  /**
   * 单次执行超时（毫秒，最小 60000 即 1 分钟——低于阈值在扫描期报错）。声明后该
   * 任务在独立 worker 线程执行，超时两段式取消（先 abort 信号宽限，未退出
   * terminate 硬杀）——判定超时即执行真正终止。未声明走进程内执行（零开销）。
   *
   * 最小值的理由：声明 timeoutMs 的语义是"这是需要真取消的长任务"，一分钟内能
   * 跑完的任务没必要声明超时（走进程内，需要 deadline 自行用 Promise.race 实现）；
   * 且超时从派发起算、包含 worker 冷启动（线程创建 + 模块加载），过小的超时会在
   * 任务做任何事之前就被取消。
   */
  timeoutMs?: number;
  /**
   * 取消宽限期（毫秒，仅声明 `timeoutMs` 的隔离任务生效）：两段式取消第一段
   * 发出 abort 信号后等待任务自行退出的最长时间，超时未退出 `terminate()` 硬杀。
   * 默认 5000（5s）；`0` 表示不留宽限期（判定取消即硬杀）。
   * 未声明 `timeoutMs` 的任务无取消流程，本字段被忽略。
   */
  graceMs?: number;
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
  timeoutMs?: number;
  graceMs?: number;
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
  timeoutMs?: number;
  /** 取消宽限期（毫秒，仅隔离任务生效），未声明用框架默认 5s */
  graceMs?: number;
}

/**
 * 任务记录状态
 *
 * cancelled = 执行被框架终止（超时两段式取消 / 停机取消），区别于 run 自身抛错的 failed；
 * 驱动重试时记录回到 running 继续流转。
 */
export type TaskJobStatus = 'pending' | 'running' | 'retry' | 'done' | 'failed' | 'cancelled';

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
  createdAt: number;
  /** 计划执行时间戳（重试/延迟任务与 createdAt 不同） */
  runAt?: number;
}

/**
 * 隔离执行跨线程传递的注册表快照（纯数据，结构化克隆安全）
 *
 * 注册表对象含函数闭包不可 postMessage；元数据本身是纯数据——语义层从
 * `TaskRegistriesView` 生成快照，worker wrapper 内重建只读视图。
 */
export interface TaskRegistriesSnapshot {
  /** agent 完整元数据（含 filePath/hasRun，非仅 LLM 可见字段） */
  agents: AgentMetadata[];
  tools: ToolMetadata[];
  skills: AgentCore[];
}

/**
 * 传给任务 run 函数的第二参数
 */
export interface TaskContext {
  /** 优雅停机时对在跑任务 abort 的信号 */
  signal: AbortSignal;
  /** faapi.config.ts 全量配置（含自定义业务配置） */
  config: unknown;
  job: { id: string; name: string; attempt: number };
  /**
   * app 注册表只读视图（agent/tool/skill 元数据查询，不含 hydrate/clear 写接口）
   *
   * 进程内执行为活引用；隔离执行为派发时刻的快照视图（worker 内重建）——
   * 执行中途的 reload/DB skill 变更不影响当次执行。
   * 任务内组装 agent 用 `registries.agent.getAgentEntry(name)`（含 filePath/hasRun）。
   */
  registries: TaskRegistriesView;
  /**
   * 进度上报（可选）：执行中主动上报进度，记入 `TaskJob.progress`（`list()` 可见）
   *
   * 进程内直写记录；隔离路径经 postMessage 回传宿主（值必须可结构化克隆，
   * 不可克隆按执行错误处理）。仅 running 状态生效，终态后调用被忽略。
   */
  progress?: (value: unknown) => void;
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
    opts?: { delayMs?: number; dedupId?: string },
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
  /** faapi.config.ts 全量配置，透传给 run 的 TaskContext.config */
  config?: unknown;
  /**
   * app 注册表只读视图（`createTaskRegistriesView`）——注入两条执行路径的
   * TaskContext.registries；缺省为空视图（直接构造队列的测试/嵌入场景）
   */
  registries?: TaskRegistriesView;
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
   * 隔离执行器（默认 runTaskInWorker）——任务声明 timeoutMs 时由语义层调用，
   * 独立 worker 线程执行 + 超时两段式取消；测试注入 spy 验证执行路径路由
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
