import type { TaskDriver, TaskDriverProcess } from '@faapi/faapi';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';

/**
 * BullMQ 驱动选项
 */
export interface BullMQDriverOptions {
  /** Redis 连接配置（透传给 Queue / Worker 的 connection） */
  connection: ConnectionOptions;
  /** 队列名前缀（默认 `faapi`——同一 Redis 下多个 faapi 应用隔离用） */
  prefix?: string;
}

/**
 * faapi 任务队列 BullMQ 驱动（Redis 持久化队列）
 *
 * 与 faapi 主包 `config.task.driver: 'bullmq'` 配合使用：
 *
 * ```ts
 * // faapi.config.ts
 * export default {
 *   task: {
 *     driver: 'bullmq',
 *     bullmq: { connection: { host: '127.0.0.1', port: 6379 } },
 *   },
 * } satisfies FaapiConfig;
 * ```
 *
 * 语义映射（详见包根 README）：
 * - `enqueue` → `queue.add(name, payload, { delay, attempts, backoff })`（每任务一个 Queue）
 * - `startWorker` → `new Worker(name, handler, { connection, concurrency })`
 * - `stop` → workers.close() + queues.close()（等 in-flight；超时由 BullMQ 处置）
 * - 重试 → BullMQ 侧执行（attempts = retries + 1，指数退避 500ms 起）
 */
export function createBullMQDriver(options: BullMQDriverOptions): TaskDriver {
  if (!options?.connection) {
    throw new Error('[faapi] @faapi/task-bullmq requires `bullmq.connection` in config.task');
  }
  const prefix = options.prefix ?? 'faapi';

  let stopped = false;
  /** 每任务一个 Queue（按名缓存） */
  const queues = new Map<string, Queue>();
  /** 已创建的 Worker（stopWorkers / stop 时关闭） */
  const workers = new Map<string, Worker>();

  function getQueue(name: string): Queue {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: options.connection, prefix });
      queues.set(name, q);
    }
    return q;
  }

  /** 驱动侧 attempt 计数（兼容不同 BullMQ 版本的 attemptsMade/attemptsStarted 字段差异） */
  const attemptCounts = new Map<string, number>();

  return {
    async enqueue(name, payload, opts) {
      if (stopped) {
        throw new Error('[faapi] Task queue is stopped and no longer accepts jobs');
      }
      const queue = getQueue(name);
      const job = await queue.add(name, payload, {
        // BullMQ attempts 含首次执行，retries 是额外重试次数
        attempts: (opts?.retries ?? 0) + 1,
        backoff: { type: 'exponential', delay: 500 },
        ...(opts?.delayMs ? { delay: opts.delayMs } : {}),
      });
      return job.id ?? crypto.randomUUID();
    },

    async startWorker(name, workerOpts) {
      const process: TaskDriverProcess = workerOpts.process;
      // 二次注册（reload 场景）先关旧 Worker
      const existing = workers.get(name);
      if (existing) {
        await existing.close();
      }
      const worker = new Worker(
        name,
        async (job: Job) => {
          const attempt = (attemptCounts.get(job.id ?? '') ?? 0) + 1;
          attemptCounts.set(job.id ?? '', attempt);
          return await process({
            id: job.id ?? '',
            name,
            payload: job.data,
            attempt,
            signal: new AbortController().signal, // BullMQ 不提供执行中任务的取消信号
          });
        },
        { connection: options.connection, concurrency: workerOpts.concurrency, prefix },
      );
      // 处理器内部异常已由语义层包装记录；这里兜底防止 unhandled error 事件崩进程
      worker.on('error', (err) => {
        console.error(`[faapi] bullmq worker error for task "${name}":`, err);
      });
      workers.set(name, worker);
    },

    async stop(timeoutMs = 10_000) {
      stopped = true;
      const closes = [
        ...Array.from(workers.values()).map((w) => w.close()),
        ...Array.from(queues.values()).map((q) => q.close()),
      ];
      workers.clear();
      const timeout = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      });
      await Promise.race([Promise.all(closes), timeout]);
      attemptCounts.clear();
    },

    async stopWorkers() {
      const closes = Array.from(workers.values()).map((w) => w.close());
      workers.clear();
      await Promise.all(closes);
    },
  };
}
