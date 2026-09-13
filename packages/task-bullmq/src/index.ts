import type { TaskDriver, TaskDriverProcess, TaskDriverRecord, TaskJobStatus } from '@faapi/faapi';
import { Queue, Worker, type ConnectionOptions, type Job, type JobType } from 'bullmq';

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
 * - `stop` → workers.close() + queues.close()（等 in-flight；超时 abort 在跑任务的 signal）
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
  /** 在跑任务的取消控制器（stop 超时 abort——run 监听 signal 可尽快退出） */
  const inflight = new Map<string, AbortController>();

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
        // dedupId 幂等键：同 jobId 的 job 存活期内 add 被忽略（BullMQ 原生去重）
        ...(opts?.dedupId ? { jobId: opts.dedupId } : {}),
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
          const id = job.id ?? '';
          const attempt = (attemptCounts.get(id) ?? 0) + 1;
          attemptCounts.set(id, attempt);
          // 信号由驱动自管：stop 超时 abort（BullMQ 自身不提供执行中任务的取消能力）
          const controller = new AbortController();
          inflight.set(id, controller);
          try {
            return await process({
              id,
              name,
              payload: job.data,
              attempt,
              signal: controller.signal,
            });
          } finally {
            inflight.delete(id);
          }
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
      // 等待超时到点 abort 在跑任务（run 监听 signal 尽快退出）；等待结束后兜底 abort 残留
      const abortTimer = setTimeout(() => {
        for (const controller of inflight.values()) controller.abort();
      }, timeoutMs);
      try {
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
      } finally {
        clearTimeout(abortTimer);
        for (const controller of inflight.values()) controller.abort();
        inflight.clear();
        attemptCounts.clear();
      }
    },

    async stopWorkers() {
      const closes = Array.from(workers.values()).map((w) => w.close());
      workers.clear();
      await Promise.all(closes);
    },

    async list(opts) {
      const limit = opts?.limit ?? 50;
      // 目标队列：指定 name 时按需创建 Queue 实例；不传时遍历本进程已创建的
      // （BullMQ 队列按 Redis key 寻址，额外实例不影响驱动内的队列）
      const targets: Queue[] = opts?.name ? [getQueue(opts.name)] : [...queues.values()];
      // faapi 语义状态 → BullMQ JobType 分组（cancel 为 job.remove，无 cancelled 可查；
      // 重试等待中的 job 处于 delayed → 归入 pending）
      const stateTypes: Partial<Record<TaskJobStatus, JobType[]>> = {
        pending: ['waiting', 'delayed'],
        running: ['active'],
        done: ['completed'],
        failed: ['failed'],
      };
      const wanted = (opts?.state ? [opts.state] : ['pending', 'running', 'done', 'failed']).filter(
        (s): s is TaskJobStatus => (stateTypes[s as TaskJobStatus]?.length ?? 0) > 0,
      );

      const records: TaskDriverRecord[] = [];
      for (const status of wanted) {
        const types = stateTypes[status]!;
        for (const queue of targets) {
          const jobs = await queue.getJobs(types, 0, limit - 1);
          for (const job of jobs) {
            if (!job) continue;
            records.push({
              id: job.id ?? '',
              name: job.name,
              payload: job.data,
              status,
              attempts: job.attemptsMade ?? 0,
              ...(job.returnvalue !== undefined && job.returnvalue !== null
                ? { result: job.returnvalue }
                : {}),
              ...(job.failedReason ? { error: job.failedReason } : {}),
              createdAt: job.timestamp,
              ...(job.processedOn ? { runAt: job.processedOn } : {}),
            });
          }
        }
      }
      return records.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },

    async cancel(name, id) {
      if (stopped) {
        throw new Error(
          '[faapi] Task queue is stopped and no longer accepts management operations',
        );
      }
      // BullMQ 无 cancelled 状态——取消即移除（等待/延迟中的不再执行；active 受锁限制由 BullMQ 抛错）
      const job = await getQueue(name).getJob(id);
      if (job) await job.remove();
    },

    async retry(name, id) {
      if (stopped) {
        throw new Error(
          '[faapi] Task queue is stopped and no longer accepts management operations',
        );
      }
      const job = await getQueue(name).getJob(id);
      if (!job) {
        throw new Error(`[faapi] Task "${name}" job "${id}" not found`);
      }
      await job.retry(); // 仅 failed 可重试；其余状态由 BullMQ 抛错
    },
  };
}
