import type { TaskRegistry } from './taskRegistry';
import type { TaskDriver } from './driverTypes';

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

/** 任务记录状态 */
export type TaskJobStatus = 'pending' | 'running' | 'retry' | 'done' | 'failed';

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
  createdAt: number;
  /** 计划执行时间戳（重试/延迟任务与 createdAt 不同） */
  runAt?: number;
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
   * @returns 任务 id
   * @throws 任务不存在 / 队列已停止 / payload 校验失败（ValidationError）
   */
  enqueue(name: string, payload?: unknown, opts?: { delayMs?: number }): Promise<{ id: string }>;
  /** 任务记录快照（可按任务名过滤） */
  list(name?: string): TaskJob[];
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
   * 队列驱动（默认 memoryDriver——进程内数组，重启丢任务）
   * 外部驱动：`@faapi/task-pgboss` / `@faapi/task-bullmq` 或自定义 TaskDriver 实例
   */
  driver?: TaskDriver;
  /** 任务模块加载器（默认：import 产物路径） */
  loadTaskModule?: (filePath: string) => Promise<TaskModule>;
  /** payload schema 加载器（默认：import 任务目录 zod.js，取首个 `*Schema` 导出） */
  loadPayloadSchema?: (filePath: string) => Promise<unknown>;
}
