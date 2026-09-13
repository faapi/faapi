import { randomUUID } from 'node:crypto';
import type { TaskDriver, TaskDriverJob, TaskDriverProcess } from './driverTypes';

/**
 * 内存驱动内部任务（payload + 调度私有状态）
 */
interface MemoryJob {
  id: string;
  payload: unknown;
  retries: number;
  runAt: number;
  /** 已执行次数（dispatch 进入时自增） */
  attempts: number;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

/** 重试退避基数（ms）与封顶 */
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;

/**
 * 进程内内存驱动（TaskDriver 默认实现，零依赖）
 *
 * 行为与第一版内存队列一致（taskQueue 重构前的原始语义）：
 * - 入队进每任务 FIFO 数组；延迟任务由 runAt 控制
 * - 每任务最多 concurrency 个并行（startWorker 注册时给定）
 * - 失败按 retries 指数退避重试（500ms * 2^(n-1)，封顶 30s）；耗尽后丢弃（失败记录由语义层在最后一次 process 抛错时写入）
 * - stop(timeoutMs)：停止出队 + 停接受新任务，等在跑任务，超时 abort；重试等待中的任务取消（视为失败）
 *
 * 取舍不变：重启即丢、多实例不防重跑（fallback.md）。
 */
export function createMemoryDriver(): TaskDriver {
  /** 全部内部任务（含等待重试） */
  const jobs = new Map<string, MemoryJob>();
  /** 每任务待执行 FIFO（job id） */
  const pendingByTask = new Map<string, string[]>();
  /** 每任务在跑数量 */
  const runningCount = new Map<string, number>();
  /** 已注册 worker（name → 并发与执行函数） */
  const workers = new Map<string, { concurrency: number; process: TaskDriverProcess }>();

  let stopped = false;

  function pump(): void {
    if (stopped) return;
    for (const [name, worker] of workers) {
      const queue = pendingByTask.get(name);
      if (!queue || queue.length === 0) continue;
      let running = runningCount.get(name) ?? 0;
      while (running < worker.concurrency && queue.length > 0) {
        const head = jobs.get(queue[0]!);
        if (!head) {
          queue.shift();
          continue;
        }
        if (head.runAt > Date.now()) break; // FIFO：队首未到 runAt 则整体让行
        queue.shift();
        running += 1;
        runningCount.set(name, running);
        void dispatch(name, worker, head);
      }
      if (running === 0) runningCount.delete(name);
      else runningCount.set(name, running);
    }
  }

  async function dispatch(
    name: string,
    worker: { concurrency: number; process: TaskDriverProcess },
    job: MemoryJob,
  ): Promise<void> {
    job.attempts += 1;
    const driverJob: TaskDriverJob = {
      id: job.id,
      name,
      payload: job.payload,
      attempt: job.attempts,
      signal: job.controller.signal,
    };
    try {
      await worker.process(driverJob);
    } catch (err) {
      if (job.attempts <= job.retries) {
        const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** (job.attempts - 1), RETRY_MAX_DELAY_MS);
        job.runAt = Date.now() + delay;
        job.timer = setTimeout(() => {
          job.timer = undefined;
          pendingByTask.get(name)?.push(job.id);
          pump();
        }, delay);
      }
      // 重试耗尽：任务就此丢弃——失败记录已由语义层在 process 抛错时写入
      void err;
    } finally {
      const running = (runningCount.get(name) ?? 1) - 1;
      if (running <= 0) runningCount.delete(name);
      else runningCount.set(name, running);
      pump();
    }
  }

  return {
    async enqueue(name, payload, opts) {
      if (stopped) {
        throw new Error('[faapi] Task queue is stopped and no longer accepts jobs');
      }
      const id = randomUUID();
      const job: MemoryJob = {
        id,
        payload,
        retries: opts?.retries ?? 0,
        runAt: opts?.delayMs ? Date.now() + opts.delayMs : Date.now(),
        attempts: 0,
        controller: new AbortController(),
      };
      jobs.set(id, job);
      if (job.runAt > Date.now()) {
        // 延迟任务：到点再进待执行队列
        job.timer = setTimeout(() => {
          job.timer = undefined;
          pendingByTask.get(name)?.push(id);
          pump();
        }, job.runAt - Date.now());
      } else {
        let q = pendingByTask.get(name);
        if (!q) {
          q = [];
          pendingByTask.set(name, q);
        }
        q.push(id);
        pump();
      }
      return id;
    },

    startWorker(name, opts) {
      workers.set(name, opts);
      pump();
    },

    async stop(timeoutMs = 10_000) {
      stopped = true;
      // 取消重试/延迟等待中的定时器（停止后不再恢复；记录由语义层已为 failed）
      for (const job of jobs.values()) {
        if (job.timer) {
          clearTimeout(job.timer);
          job.timer = undefined;
        }
      }
      // 等 in-flight 归零；超时对在跑任务 abort
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const total = Array.from(runningCount.values()).reduce((sum, n) => sum + n, 0);
        if (total === 0) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      for (const job of jobs.values()) {
        job.controller.abort();
      }
    },

    async stopWorkers() {
      workers.clear();
    },
  };
}
