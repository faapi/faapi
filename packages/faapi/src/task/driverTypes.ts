/**
 * 任务队列驱动抽象（语义层与存储/调度实现分离的边界）
 *
 * 语义层（taskQueue）负责：任务存在性检查、payload zod 校验、任务模块加载、
 * run 执行包装、任务记录（list）；驱动层负责：入队存储、worker 消费、
 * 失败重试、停机 drain。换驱动 = 换存储，业务方写法不变。
 *
 * 框架不内置任何驱动实现：外部驱动由独立子包提供——`@faapi/task-pgboss`（Postgres）、
 * `@faapi/task-bullmq`（Redis），主包不依赖它们——按 config.task.driver 动态加载
 * （loadTaskDriver.ts）；无任务清单时用 idleTaskDriver 占位（enqueue 显式报错）。
 */
import type { TaskRegistry } from './taskRegistry';
import type { TaskJobStatus } from './taskTypes';

/** 驱动层交付给语义层执行的单个任务 */
export interface TaskDriverJob {
  /** 队列系统侧任务 id（pg-boss/bullmq 为其自身 id；自定义驱动自行生成） */
  id: string;
  name: string;
  payload: unknown;
  /** 第几次执行（从 1 起，含重试） */
  attempt: number;
  /** 停机/取消信号；驱动不支持取消时为永不 abort 的信号 */
  signal: AbortSignal;
}

/** 语义层交给驱动层的执行函数（抛错 = 失败，由驱动按入队时的 retries 重试） */
export type TaskDriverProcess = (job: TaskDriverJob) => Promise<unknown>;

/**
 * 驱动侧任务查询记录（TaskDriver.list 的返回项）
 *
 * status 由子包从队列系统原生状态映射为 faapi 语义
 * （bullmq：waiting/delayed→pending、active→running、completed→done、failed→failed；
 * pg-boss v10 无批量列出 jobs 的公开 API，task-pgboss 未实现 list），
 * 语义层零映射直接转 TaskJob。
 */
export interface TaskDriverRecord {
  id: string;
  name: string;
  payload: unknown;
  status: TaskJobStatus;
  attempts: number;
  /** 执行返回值（已完成时） */
  result?: unknown;
  /** 失败/取消原因 */
  error?: string;
  createdAt: number;
  /** 计划执行时间戳（延迟任务） */
  runAt?: number;
}

/**
 * 任务队列驱动接口
 */
export interface TaskDriver {
  /**
   * 入队一个任务，返回驱动侧任务 id
   *
   * @param opts.retries 失败重试次数（语义层从任务 meta 取，驱动负责执行重试策略）
   * @param opts.dedupId 幂等键（可选）——同键任务在队列系统保留期内不重复入队。
   *   pgboss 映射 send 自定义 id（驱动内做任意字符串 → 确定性 UUID 映射，冲突跳过）；
   *   bullmq 映射 jobId。重复投递时返回已存在任务的 id。
   * @param opts.timeoutMs 任务执行超时毫秒（语义层从任务 meta 取）——驱动以此设置
   *   队列系统的执行硬限（pgboss 映射 expireInSeconds），防止队列系统默认限值
   *   （pg-boss DDL 15 分钟）强杀仍在运行的长任务后重试，导致同一任务两份并发执行
   * @param opts.graceMs 超时取消宽限期毫秒（与 timeoutMs 配套，驱动计入执行硬限预算）
   * @throws 驱动已停止 / 连接失败等
   */
  enqueue(
    name: string,
    payload: unknown,
    opts?: {
      delayMs?: number;
      retries?: number;
      dedupId?: string;
      timeoutMs?: number;
      graceMs?: number;
    },
  ): Promise<string>;
  /**
   * 注册某任务的消费 worker（幂等覆盖）。process 抛错 = 本次失败，驱动决定重试。
   * 调用时机：queue.start() 为注册表中每个任务注册一次。
   */
  startWorker(
    name: string,
    opts: { concurrency: number; process: TaskDriverProcess },
  ): Promise<void> | void;
  /** 停止消费并等待 in-flight 任务（timeoutMs 超时后驱动自行处置），幂等 */
  stop(timeoutMs?: number): Promise<void>;
  /** 仅停止 worker 消费（不断开驱动连接），供 dev reloadTasks 重注册用；可选 */
  stopWorkers?(): Promise<void>;
  /**
   * 查询持久化队列任务（可选能力）
   *
   * 未实现时 TaskClient.listQueued 显式抛错。pg-boss v10 无批量列出 jobs 的公开 API，
   * task-pgboss 未实现；BullMQ API 完整，task-bullmq 全支持。
   * 不传 name 时列出本进程已创建队列/已知任务的范围由驱动自行定义。
   */
  list?(opts?: {
    name?: string;
    /** 按 faapi 语义状态过滤 */
    state?: TaskJobStatus;
    /** 返回条数上限（默认由驱动决定，建议 50） */
    limit?: number;
  }): Promise<TaskDriverRecord[]>;
  /**
   * 取消队列侧任务（可选能力）：等待/延迟中的不再执行。
   * pgboss → boss.cancel（保留 cancelled 记录）；bullmq → job.remove()（记录随之移除）。
   */
  cancel?(name: string, id: string): Promise<void>;
  /**
   * 重试失败/取消的任务（可选能力）。
   * pgboss → boss.resume（仅 cancelled）；bullmq → job.retry()（仅 failed）。
   * 任务不存在 / 状态不允许时由驱动抛错。
   */
  retry?(name: string, id: string): Promise<void>;
}

/** 创建驱动时可选的工厂签名（loadTaskDriver 按包名动态加载后调用） */
export interface TaskDriverFactory {
  (options: unknown): TaskDriver;
}

/** driver 解析输入（registry 仅部分驱动需要，预留） */
export interface TaskDriverLoaderContext {
  registry: TaskRegistry;
}
