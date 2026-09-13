import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BullMQ 驱动单测：mock 'bullmq' 包，验证 faapi TaskDriver 语义到 BullMQ API 的映射
 * （真实 Redis 行为由 BullMQ 自身测试保证；本包验证的是适配层）
 */

// vi.mock 工厂被提升——Fake 类与实例收集器经 vi.hoisted 自包含
const h = vi.hoisted(() => {
  const fakeQueues: Array<{
    name: string;
    opts: Record<string, unknown>;
    adds: Array<{ name: string; data: unknown; opts: Record<string, unknown> }>;
    closed: boolean;
    add: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const fakeWorkers: Array<{
    name: string;
    handler: (job: { id: string; data: unknown }) => Promise<unknown>;
    opts: Record<string, unknown>;
    closed: boolean;
    on: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  let addCounter = 0;
  return { fakeQueues, fakeWorkers, getAddCounter: () => ++addCounter };
});

vi.mock('bullmq', () => {
  class FakeQueue {
    name: string;
    opts: Record<string, unknown>;
    adds: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];
    closed = false;
    add = vi.fn(async (name: string, data: unknown, opts: Record<string, unknown>) => {
      this.adds.push({ name, data, opts });
      return { id: `bm-${h.getAddCounter()}` };
    });
    close = vi.fn(async () => {
      this.closed = true;
    });
    constructor(name: string, opts: Record<string, unknown>) {
      this.name = name;
      this.opts = opts;
      h.fakeQueues.push(this as never);
    }
  }
  class FakeWorker {
    name: string;
    handler: (job: { id: string; data: unknown }) => Promise<unknown>;
    opts: Record<string, unknown>;
    closed = false;
    on = vi.fn(() => this);
    close = vi.fn(async () => {
      this.closed = true;
    });
    constructor(
      name: string,
      handler: (job: { id: string; data: unknown }) => Promise<unknown>,
      opts: Record<string, unknown>,
    ) {
      this.name = name;
      this.handler = handler;
      this.opts = opts;
      h.fakeWorkers.push(this as never);
    }
  }
  return { Queue: FakeQueue, Worker: FakeWorker };
});

import { createBullMQDriver } from './index';

beforeEach(() => {
  h.fakeQueues.length = 0;
  h.fakeWorkers.length = 0;
});

describe('createBullMQDriver', () => {
  it('缺少 connection 时抛错', () => {
    expect(() => createBullMQDriver(undefined as never)).toThrow('connection');
  });

  it('enqueue 映射为 queue.add（retries → attempts+1，delayMs → delay）', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    const id = await driver.enqueue('mail', { to: 'a@b.c' }, { retries: 3, delayMs: 1000 });
    const queue = h.fakeQueues.find((q) => q.name === 'mail')!;
    expect(queue.opts).toMatchObject({ connection: { host: '127.0.0.1' }, prefix: 'faapi' });
    expect(queue.adds[0]).toMatchObject({
      name: 'mail',
      data: { to: 'a@b.c' },
      opts: expect.objectContaining({ attempts: 4, delay: 1000 }),
    });
    expect(id).toBe('bm-1');
  });

  it('startWorker 创建 Worker（concurrency + prefix），process 收到映射后的 job', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    const process = vi.fn(async () => 'ok');
    await driver.startWorker('mail', { concurrency: 4, process });
    const worker = h.fakeWorkers[0]!;
    expect(worker.name).toBe('mail');
    expect(worker.opts).toMatchObject({ concurrency: 4, prefix: 'faapi' });

    const result = await worker.handler({ id: 'j1', data: { to: 'x' } });
    expect(result).toBe('ok');
    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'j1', name: 'mail', payload: { to: 'x' }, attempt: 1 }),
    );
  });

  it('process 抛错向外抛（BullMQ 按 attempts/backoff 重试），attempt 计数递增', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    const process = vi.fn(async () => {
      throw new Error('boom');
    });
    await driver.startWorker('flaky', { concurrency: 1, process });
    const worker = h.fakeWorkers[0]!;
    await expect(worker.handler({ id: 'j1', data: null })).rejects.toThrow('boom');
    await expect(worker.handler({ id: 'j1', data: null })).rejects.toThrow('boom');
    expect(process).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 2 }));
  });

  it('stop 关闭 workers + queues，之后 enqueue 拒绝新任务', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    await driver.enqueue('a', {});
    await driver.startWorker('a', { concurrency: 1, process: async () => 1 });
    await driver.stop(5000);
    expect(h.fakeWorkers[0]!.closed).toBe(true);
    expect(h.fakeQueues[0]!.closed).toBe(true);
    await expect(driver.enqueue('a', {})).rejects.toThrow('stopped');
  });

  it('stopWorkers 仅关 Worker（reload 场景），Queue 不创建', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    await driver.startWorker('a', { concurrency: 1, process: async () => 1 });
    await driver.stopWorkers?.();
    expect(h.fakeWorkers[0]!.closed).toBe(true);
    expect(h.fakeQueues).toHaveLength(0); // 未创建过 queue
    await driver.startWorker('a', { concurrency: 1, process: async () => 1 });
    expect(h.fakeWorkers).toHaveLength(2);
  });

  it('二次 startWorker 先关旧 Worker（reload 场景）', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    await driver.startWorker('a', { concurrency: 1, process: async () => 1 });
    await driver.startWorker('a', { concurrency: 2, process: async () => 1 });
    expect(h.fakeWorkers[0]!.closed).toBe(true);
    expect(h.fakeWorkers[1]!.opts.concurrency).toBe(2);
  });
});
