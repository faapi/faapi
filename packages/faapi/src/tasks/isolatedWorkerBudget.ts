import os from 'node:os';
import { TaskCancelledError } from './taskWorker';

/**
 * 隔离 worker 全局并发预算（行为契约见 [isolatedWorkerBudget.md](./isolatedWorkerBudget.md)）
 *
 * 跨任务封顶同时在跑的隔离 worker 线程数（config.task.maxIsolatedWorkers，每进程
 * 一份预算）：单任务并发（meta.concurrency）只约束同名任务，N 个隔离任务并发时
 * worker 线程数无上限累加抢核——预算在派发层（taskQueue）统一守门。等待有上限
 * （30s，低于 pgboss expire_in 预算的 60s 缓冲）：超限显式失败交驱动按 retries
 * 重试（fail fast，不无限排队占坑——排队等待不算执行时间，无限等待会被驱动判
 * 失联重投）；等待中 job.signal abort 抛 TaskCancelledError（记 cancelled）。
 */

/**
 * 席位等待上限（30s）：pgboss 驱动按 `ceil((timeoutMs + graceMs) / 1000) + 60s 缓冲`
 * 设 expire_in，等待中的派发不吃执行预算（超时从真正派发起算）——但 expire_in 照走，
 * 无限排队会被判失联重投（重投后再次排队，活锁）。30s 低于 60s 缓冲：饱和时先于
 * 驱动显式失败，重试语义交还驱动（retries 退避），不产生失联重投的活锁窗口
 */
export const ISOLATED_DISPATCH_WAIT_MS = 30_000;

/**
 * 全局预算饱和错误：席位等待超过 ISOLATED_DISPATCH_WAIT_MS 时由 acquire 抛出——
 * 非取消（TaskCancelledError）也非 run 自身失败，taskQueue 按 failed 落账，
 * 驱动按 retries 决定重试
 */
export class IsolatedDispatchSaturatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolatedDispatchSaturatedError';
  }
}

/** FIFO 等待队列条目（resolve/reject 由 acquire 闭包构造，含定时器与 abort 监听清理） */
interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class IsolatedWorkerBudget {
  private readonly limit: number;
  private readonly waitMs: number;
  private runningCount = 0;
  private readonly waiters: Waiter[] = [];

  constructor(limit: number, waitMs: number = ISOLATED_DISPATCH_WAIT_MS) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `[faapi] config.task.maxIsolatedWorkers must be a positive integer (got ${limit}) — ` +
          'it caps how many isolated worker threads may run concurrently across all tasks.',
      );
    }
    if (!Number.isInteger(waitMs) || waitMs < 1) {
      throw new Error(
        `[faapi] IsolatedWorkerBudget waitMs must be a positive integer (got ${waitMs}).`,
      );
    }
    this.limit = limit;
    this.waitMs = waitMs;
  }

  /** 当前持有席位的执行数 */
  get running(): number {
    return this.runningCount;
  }

  /** 当前排队等待席位的派发数 */
  get pending(): number {
    return this.waiters.length;
  }

  /**
   * 获取一个隔离 worker 席位
   *
   * - 上限内立即占用返回；满员进入 FIFO 等待队列（waitMs 超时 → IsolatedDispatchSaturatedError）
   * - signal 已 aborted 立即抛 TaskCancelledError；等待中 abort 同样抛出——
   *   两种失败路径都不占用席位（定时器清理 + 出队）
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new TaskCancelledError(
        'Isolated dispatch cancelled before acquiring a worker slot (signal already aborted)',
      );
    }
    if (this.runningCount < this.limit) {
      this.runningCount++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(waiter);
        waiter.reject(
          new IsolatedDispatchSaturatedError(
            `Waited ${this.waitMs}ms for a global isolated worker slot (limit ${this.limit}, ` +
              `running ${this.runningCount}) — the global isolated worker budget is saturated. ` +
              'Raise config.task.maxIsolatedWorkers or lower per-task concurrency (meta.concurrency); ' +
              'the dispatch fails explicitly instead of queueing indefinitely (queue drivers budget ' +
              'expire_in from timeoutMs and would re-deliver a waiting execution).',
          ),
        );
      }, this.waitMs);
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      };
      const waiter: Waiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      if (signal) {
        onAbort = () => {
          this.removeWaiter(waiter);
          waiter.reject(
            new TaskCancelledError(
              'Isolated dispatch cancelled while waiting for a global worker slot',
            ),
          );
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** 归还席位：有等待者时直接交接（计数先减后增同步完成，无可观测的空档） */
  release(): void {
    this.runningCount--;
    const next = this.waiters.shift();
    if (next) {
      this.runningCount++;
      next.resolve();
    }
  }

  private removeWaiter(waiter: Waiter): void {
    const idx = this.waiters.indexOf(waiter);
    if (idx !== -1) this.waiters.splice(idx, 1);
  }
}

/**
 * 默认全局预算：预留 1 核给宿主（HTTP 事件循环 + 驱动心跳等），其余核位供
 * 隔离 worker 使用；单核机器退化为 1（仍保留跨任务封顶语义）
 */
export function resolveDefaultIsolatedWorkerLimit(): number {
  return Math.max(1, os.availableParallelism() - 1);
}
