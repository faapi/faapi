/**
 * 任务队列驱动抽象（语义层与存储/调度实现分离的边界）
 *
 * 语义层（taskQueue）负责：任务存在性检查、payload zod 校验、任务模块加载、
 * run 执行包装、任务记录（list）；驱动层负责：入队存储、worker 消费、
 * 失败重试、停机 drain。换驱动 = 换存储，业务方写法不变。
 *
 * 内置 memory 驱动（memoryDriver.ts，进程内数组，零依赖）；
 * 外部驱动由独立子包提供：`@faapi/task-pgboss`（Postgres）、`@faapi/task-bullmq`（Redis），
 * 主包不依赖它们——按 config.task.driver 动态加载（loadTaskDriver.ts）。
 */
import type { TaskRegistry } from './taskRegistry';

/** 驱动层交付给语义层执行的单个任务 */
export interface TaskDriverJob {
  /** 队列系统侧任务 id（memory 为 uuid；pg-boss/bullmq 为其自身 id） */
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
 * 任务队列驱动接口
 */
export interface TaskDriver {
  /**
   * 入队一个任务，返回驱动侧任务 id
   *
   * @param opts.retries 失败重试次数（语义层从任务 meta 取，驱动负责执行重试策略）
   * @throws 驱动已停止 / 连接失败等
   */
  enqueue(
    name: string,
    payload: unknown,
    opts?: { delayMs?: number; retries?: number },
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
}

/** 创建驱动时可选的工厂签名（loadTaskDriver 按包名动态加载后调用） */
export interface TaskDriverFactory {
  (options: unknown): TaskDriver;
}

/** driver 解析输入（registry 仅部分驱动需要，预留） */
export interface TaskDriverLoaderContext {
  registry: TaskRegistry;
}
