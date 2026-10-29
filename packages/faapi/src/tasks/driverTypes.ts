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
import type {
  TaskGroupOnFailure,
  TaskGroupOutcome,
  TaskGroupSnapshot,
  TaskJobStatus,
} from './taskTypes';

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
  /** 所属批量（批量任务的成员任务携带；驱动在交付时从批量标识载体还原） */
  groupId?: string;
  /** 批量内成员序号（0 基；串行序列成员携带，驱动从载荷包装还原） */
  groupIndex?: number;
  /** 挂起/激活上下文（激活重投的执行携带；驱动在交付时从挂起信封载体还原） */
  resumeState?: TaskResumeState;
  /**
   * enqueue 时携带的执行上下文快照（身份/标记等纯数据；驱动在交付时从载荷
   * 包装还原，语义层注入 `taskCtx.carry` / 惰性 agent 通道的合成 ctx）
   */
  carry?: Record<string, unknown>;
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
  /** 所属批量（批量任务的成员任务携带；驱动从批量标识载体还原后返回） */
  groupId?: string;
  /** 批量内成员序号（0 基；串行序列成员携带，驱动从载荷包装还原后返回） */
  groupIndex?: number;
  /** enqueue 时携带的执行上下文快照（驱动从载荷包装还原后返回） */
  carry?: Record<string, unknown>;
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
      /**
       * 所属批量（批量任务成员携带，可选）——驱动以此把批量标识随任务持久化
       * （载体为驱动内部实现，两内置驱动以载荷包装形态存储），交付/查询时还原为
       * `TaskDriverJob.groupId` / `TaskDriverRecord.groupId`
       */
      groupId?: string;
      /**
       * 批量内成员序号（0 基，可选；串行序列成员激活入队携带，与 groupId 配套）——
       * 驱动以此登记成员行序号（激活指针推进的记账依据）并随任务持久化（载荷包装
       * 形态），交付/查询时还原为 `TaskDriverJob.groupIndex` / `TaskDriverRecord.groupIndex`
       */
      groupIndex?: number;
      /**
       * 挂起/激活上下文（激活重投携带，可选）——驱动以此随任务持久化（载体同
       * 组标识，载荷包装形态），交付时还原为 `TaskDriverJob.resumeState`
       */
      resumeState?: TaskResumeState;
      /**
       * 执行上下文快照（身份/标记等纯数据，可选）——驱动以此随任务持久化
       * （载体同组标识，载荷包装形态；纯数据可结构化克隆，跨实例/重启正确），
       * 交付/查询时还原为 `TaskDriverJob.carry` / `TaskDriverRecord.carry`
       */
      carry?: Record<string, unknown>;
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
  /**
   * 批量记账（可选能力，整对象实现——未实现时 TaskClient.enqueueSequence /
   * enqueueBatch / getGroup 显式抛错）。语义与两内置驱动的存储映射见 taskBatch.md。
   *
   * 记账语义约束（实现须满足）：
   * - 成员落定**幂等**——同一成员重复 settle 不重复计数（成员行 settled 守卫）
   * - settle/unsettle 的计数与成员状态翻转须原子（单条 SQL / Lua）
   * - 记账状态持久化在驱动存储，跨实例/重启正确
   */
  groups?: TaskDriverGroupOps;
  /**
   * 任务挂起信封存储（可选能力，整对象实现——未实现时 `taskCtx.suspend` /
   * `TaskClient.resume` 显式抛错）。语义与两内置驱动的存储映射见 taskSuspend.md。
   *
   * 实现约束：
   * - 信封跨实例/重启正确（持久化在驱动存储，非进程内存）
   * - `set` 对同 jobId 覆盖（同一任务可多次挂起，信封随之更新）
   */
  taskState?: TaskDriverTaskStateOps;
}

/** 挂起/激活上下文（激活重投时随执行传递，还原为 `taskCtx.resumed`） */
export interface TaskResumeState {
  /** 挂起时暂存的业务状态 */
  state?: unknown;
  /** 本次激活注入的附加数据（审批意见等） */
  inject?: unknown;
  /** 第几次激活（从 1 起，信封内递增） */
  activations: number;
}

/** 挂起信封（驱动侧存储载体，resume 重投与重启水合的数据源） */
export interface TaskStateEntry {
  jobId: string;
  /** 任务名 */
  task: string;
  /** 原始 payload（resume 重投用——重投不经业务重放） */
  payload: unknown;
  /** 业务暂存状态 */
  state?: unknown;
  /** 挂起时刻（毫秒） */
  suspendedAt: number;
  /** 已激活次数（resume 时 +1 写入新执行上下文） */
  activations: number;
}

/**
 * 任务挂起信封存储驱动能力（TaskDriver.taskState）
 */
export interface TaskDriverTaskStateOps {
  /** 写入/覆盖信封（suspend 时调用） */
  set(jobId: string, entry: TaskStateEntry): Promise<void>;
  /** 读取信封；不存在返回 undefined */
  get(jobId: string): Promise<TaskStateEntry | undefined>;
  /** 删除信封（resume 读出即删 / cancel 掐死挂起线） */
  delete(jobId: string): Promise<void>;
  /** 全量信封（重启水合数据源——量级 = 挂起中任务数） */
  list(): Promise<TaskStateEntry[]>;
}

/**
 * 批量记账 create 的声明（enqueueSequence / enqueueBatch 语义层透传）
 *
 * 串行序列（mode='serial'）的 payloads/carry 随序列行持久化——激活发生在无调用栈
 * 上下文的任意实例/重启之后，清单必须框架承载；并行批次（mode='parallel'）成员
 * payload 随任务入队，payloads 不使用。
 */
export interface TaskDriverGroupCreate {
  id: string;
  /** 成员任务名（一个批量一个任务名） */
  task: string;
  total: number;
  onComplete?: string;
  onFailure: TaskGroupOnFailure;
  /** 执行形态：'serial' 串行有序（payloads 必填）| 'parallel' 并行无序（payloads 忽略） */
  mode: 'serial' | 'parallel';
  /** 逐成员 payload（mode='serial' 必填，登记时全量校验后的值；parallel 忽略） */
  payloads?: unknown[];
  /** 执行上下文快照（mode='serial' 时随序列行持久化，每条激活入队注入；parallel 忽略） */
  carry?: Record<string, unknown>;
}

/**
 * settle 的返回：记账后快照 + 是否本次落定使批量到达全部落定；serial 序列真推进
 * 激活指针时附带下一条成员（记账与指针推进同一原子操作——落定即激活无崩溃窗口）
 */
export type TaskDriverGroupSettleResult = TaskGroupSnapshot & {
  /** 本次落定后 settled >= total */
  isLast: boolean;
  /**
   * serial 序列真推进激活指针（GREATEST(nextIndex, memberIndex+1)）且未到顶时的
   * 下一条成员：index 为 0 基成员序号、payload 为登记时持久化的成员 payload、carry
   * 为序列级声明。重放落定（指针已越过该成员位置）不推进、无 next（语义层 dedupId
   * 幂等兜底重复激活）；fail-fast 成员最终失败不推进（语义层按形态走 settleRemaining /
   * cancelRemaining）；parallel 批次恒无 next（成员随 enqueueBatch 全量入队）
   */
  next?: { index: number; payload: unknown; carry?: Record<string, unknown> };
};

/**
 * 批量记账驱动能力（TaskDriver.groups；服务 TaskClient.enqueueSequence /
 * enqueueBatch，类型命名沿用组记账历史——存储表/hash 键名一致，不另开命名）
 */
export interface TaskDriverGroupOps {
  /**
   * 创建批量记账。同 id 重复创建：参数完全一致幂等跳过；不一致抛错
   * （批量标识是业务关联键，形状漂移属调用方错误）
   */
  create(decl: TaskDriverGroupCreate): Promise<void>;
  /**
   * 记账一次成员落定（幂等——已落定成员重复 settle 计数不变）
   *
   * @param outcome 成员最终终态
   * @returns 记账后快照；isLast = 本次落定后 settled >= total
   * @throws 批量不存在
   */
  settle(
    groupId: string,
    jobId: string,
    outcome: TaskGroupOutcome,
  ): Promise<TaskDriverGroupSettleResult>;
  /** 逆向记账：成员重试回 pending 时撤销一次落定（成员未落定时 no-op） */
  unsettle(groupId: string, jobId: string): Promise<void>;
  /** 标记完成回调已入队（幂等） */
  markCompletionEnqueued(groupId: string): Promise<void>;
  /** 批量快照；不存在返回 undefined */
  get(groupId: string): Promise<TaskGroupSnapshot | undefined>;
  /**
   * parallel fail-fast：取消批量内未落定成员（等待/延迟中的不再执行；在跑的自然
   * 跑完），实际取消成功的成员落定为 cancelled（幂等守卫防与运行实例的落定竞态
   * 重复计数），返回记账后快照。对 run-to-completion 批量为 no-op（返回当前快照）。
   * serial 序列语义层不调用（fail-fast 走 settleRemaining——未激活成员无队列任务可取消）。
   */
  cancelRemaining(groupId: string): Promise<TaskGroupSnapshot>;
  /**
   * serial fail-fast：把序列内未落定成员按指定 outcome 补齐落定（未激活成员无
   * 成员行——按计数差值补齐；幂等守卫防重复，差值为 0 时不计数），返回记账后
   * 快照（供 fan-in 判定）。parallel 批次语义层不调用（fail-fast 走 cancelRemaining）。
   *
   * @throws 批量不存在
   */
  settleRemaining(groupId: string, outcome: TaskGroupOutcome): Promise<TaskGroupSnapshot>;
}

/** 创建驱动时可选的工厂签名（loadTaskDriver 按包名动态加载后调用） */
export interface TaskDriverFactory {
  (options: unknown): TaskDriver;
}

/** driver 解析输入（registry 仅部分驱动需要，预留） */
export interface TaskDriverLoaderContext {
  registry: TaskRegistry;
}
