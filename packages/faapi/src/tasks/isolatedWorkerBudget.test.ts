import { describe, it, expect } from 'vitest';
import os from 'node:os';
import {
  IsolatedWorkerBudget,
  IsolatedDispatchSaturatedError,
  ISOLATED_DISPATCH_WAIT_MS,
  resolveDefaultIsolatedWorkerLimit,
} from './isolatedWorkerBudget';
import { TaskCancelledError } from './taskWorker';

describe('IsolatedWorkerBudget', () => {
  it('上限内 acquire 立即获得席位，release 归还', async () => {
    const budget = new IsolatedWorkerBudget(2, 1_000);
    await budget.acquire();
    await budget.acquire();
    expect(budget.running).toBe(2);
    expect(budget.pending).toBe(0);
    budget.release();
    expect(budget.running).toBe(1);
    budget.release();
    expect(budget.running).toBe(0);
  });

  it('超出上限 acquire 排队等待，release 按 FIFO 交接席位', async () => {
    const budget = new IsolatedWorkerBudget(1, 5_000);
    await budget.acquire();
    const second = budget.acquire();
    const third = budget.acquire();
    expect(budget.pending).toBe(2);
    budget.release();
    await second;
    // 席位直接交接给 next waiter，不经过 running=0 的中间态
    expect(budget.running).toBe(1);
    expect(budget.pending).toBe(1);
    budget.release();
    await third;
    // third 仍持有交接来的席位——再 release 才真正归还
    expect(budget.running).toBe(1);
    budget.release();
    expect(budget.running).toBe(0);
    expect(budget.pending).toBe(0);
  });

  it('席位等待超过 waitMs：抛 IsolatedDispatchSaturatedError，不占席位', async () => {
    const budget = new IsolatedWorkerBudget(1, 10);
    await budget.acquire();
    await expect(budget.acquire()).rejects.toThrow(IsolatedDispatchSaturatedError);
    budget.release();
    expect(budget.running).toBe(0);
    expect(budget.pending).toBe(0);
  });

  it('等待中 signal abort：抛 TaskCancelledError，不占席位', async () => {
    const budget = new IsolatedWorkerBudget(1, 5_000);
    await budget.acquire();
    const ctrl = new AbortController();
    const waiting = budget.acquire(ctrl.signal);
    ctrl.abort();
    await expect(waiting).rejects.toThrow(TaskCancelledError);
    budget.release();
    expect(budget.running).toBe(0);
    expect(budget.pending).toBe(0);
  });

  it('acquire 时 signal 已 aborted：立即抛 TaskCancelledError', async () => {
    const budget = new IsolatedWorkerBudget(1, 1_000);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(budget.acquire(ctrl.signal)).rejects.toThrow(TaskCancelledError);
    // 失败的 acquire 不消耗席位
    await budget.acquire();
    expect(budget.running).toBe(1);
  });

  it('limit 非法（0/负数/非整数/NaN）：构造期抛错（fail fast）', () => {
    expect(() => new IsolatedWorkerBudget(0, 1_000)).toThrow(/maxIsolatedWorkers|positive integer/);
    expect(() => new IsolatedWorkerBudget(-1, 1_000)).toThrow(
      /maxIsolatedWorkers|positive integer/,
    );
    expect(() => new IsolatedWorkerBudget(1.5, 1_000)).toThrow(
      /maxIsolatedWorkers|positive integer/,
    );
    expect(() => new IsolatedWorkerBudget(Number.NaN, 1_000)).toThrow(
      /maxIsolatedWorkers|positive integer/,
    );
  });

  it('ISOLATED_DISPATCH_WAIT_MS 为 30s（低于 pgboss expire_in 的 60s 缓冲）', () => {
    expect(ISOLATED_DISPATCH_WAIT_MS).toBe(30_000);
  });

  it('resolveDefaultIsolatedWorkerLimit：默认 max(1, availableParallelism() - 1)', () => {
    expect(resolveDefaultIsolatedWorkerLimit()).toBe(Math.max(1, os.availableParallelism() - 1));
  });
});
