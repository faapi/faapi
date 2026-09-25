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
    store: Map<string, Array<Record<string, unknown>>>;
    byId: Map<string, Record<string, unknown>>;
    add: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    getJobs: ReturnType<typeof vi.fn>;
    getJob: ReturnType<typeof vi.fn>;
  }> = [];
  const fakeWorkers: Array<{
    name: string;
    handler: (job: { id: string; data: unknown; attemptsStarted?: number }) => Promise<unknown>;
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
    /** 测试注入：按 JobType 分组的假任务 + 按 id 索引 */
    store: Map<string, Array<Record<string, unknown>>> = new Map();
    byId: Map<string, Record<string, unknown>> = new Map();
    add = vi.fn(async (name: string, data: unknown, opts: Record<string, unknown>) => {
      this.adds.push({ name, data, opts });
      return { id: `bm-${h.getAddCounter()}` };
    });
    close = vi.fn(async () => {
      this.closed = true;
    });
    getJobs = vi.fn(async (types?: string[] | string, start = 0, end = -1) => {
      const list = (Array.isArray(types) ? types : [types ?? 'waiting']).flatMap(
        (t) => this.store.get(t) ?? [],
      );
      return end === -1 ? list.slice(start) : list.slice(start, end + 1);
    });
    getJob = vi.fn(async (id: string) => this.byId.get(id) ?? null);
    constructor(name: string, opts: Record<string, unknown>) {
      this.name = name;
      this.opts = opts;
      h.fakeQueues.push(this as never);
    }
  }
  class FakeWorker {
    name: string;
    handler: (job: { id: string; data: unknown; attemptsStarted?: number }) => Promise<unknown>;
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

    const result = await worker.handler({ id: 'j1', data: { to: 'x' }, attemptsStarted: 1 });
    expect(result).toBe('ok');
    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'j1', name: 'mail', payload: { to: 'x' }, attempt: 1 }),
    );
  });

  it('process 抛错向外抛（BullMQ 按 attempts/backoff 重试），attempt 取 job.attemptsStarted', async () => {
    // 回归：attempt 此前用进程内 Map 自计数——只增不删（内存泄漏），多实例共库或
    // 进程重启后从 1 重来（失真）。改为 BullMQ 维护的 attemptsStarted（首次执行为 1）
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    const process = vi.fn(async () => {
      throw new Error('boom');
    });
    await driver.startWorker('flaky', { concurrency: 1, process });
    const worker = h.fakeWorkers[0]!;
    await expect(worker.handler({ id: 'j1', data: null, attemptsStarted: 1 })).rejects.toThrow(
      'boom',
    );
    await expect(worker.handler({ id: 'j1', data: null, attemptsStarted: 2 })).rejects.toThrow(
      'boom',
    );
    expect(process).toHaveBeenNthCalledWith(1, expect.objectContaining({ attempt: 1 }));
    expect(process).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 2 }));
  });

  it('终态任务默认 7 天清理（removeOnComplete/removeOnFail 防 Redis 无界增长）', async () => {
    // 回归：此前未设置清理策略，BullMQ 默认永久保留终态任务，且 dedupId（jobId）
    // 去重在存活期内一直生效——周期性复用同一 dedupId 的投递被永久静默忽略
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    await driver.enqueue('mail', {});
    expect(h.fakeQueues[0]!.adds[0]!.opts).toMatchObject({
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  });

  it('removeOnComplete/removeOnFail 可覆盖（false 透传恢复 BullMQ 永不清理）', async () => {
    const driver = createBullMQDriver({
      connection: { host: '127.0.0.1' },
      removeOnComplete: false,
      removeOnFail: { count: 10 },
    });
    await driver.enqueue('mail', {});
    expect(h.fakeQueues[0]!.adds[0]!.opts).toMatchObject({
      removeOnComplete: false,
      removeOnFail: { count: 10 },
    });
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

  it('stop 后 abort 在跑任务的 signal（run 可感知停机退出）', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    const captured: AbortSignal[] = [];
    const process = vi.fn(async (job: { signal: AbortSignal }) => {
      captured.push(job.signal);
      await new Promise(() => {}); // 挂起：模拟任务仍在执行
    });
    await driver.startWorker('a', { concurrency: 1, process });
    void h.fakeWorkers[0]!.handler({ id: 'j1', data: null });
    await new Promise((r) => setTimeout(r, 10));
    expect(captured[0]!.aborted).toBe(false);
    // close 立即完成 → race 结束后对残留 in-flight abort
    await driver.stop(20);
    expect(captured[0]!.aborted).toBe(true);
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

  it('list 按状态分组查询并映射为 faapi 语义（waiting/delayed→pending，active→running，completed→done，failed→failed）', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    await driver.enqueue('mail', { to: 'x' }); // 创建 queue 实例
    const queue = h.fakeQueues.find((q) => q.name === 'mail')!;
    const mkJob = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({
      id,
      name: 'mail',
      data: { to: 'x' },
      attemptsMade: 1,
      attemptsStarted: 2,
      timestamp: 1000,
      ...extra,
    });
    queue.store.set('waiting', [mkJob('w1', {})]);
    queue.store.set('delayed', [mkJob('d1', { delay: 5000 })]);
    queue.store.set('active', [mkJob('a1', {})]);
    queue.store.set('completed', [mkJob('c1', { returnvalue: 'ok' })]);
    queue.store.set('failed', [mkJob('f1', { failedReason: 'boom' })]);

    const records = await driver.list!({ name: 'mail' });
    expect(queue.getJobs).toHaveBeenCalled();
    expect(records.map((r) => r.id).sort()).toEqual(['a1', 'c1', 'd1', 'f1', 'w1']);
    const byId = new Map(records.map((r) => [r.id, r]));
    expect(byId.get('w1')!.status).toBe('pending');
    // attempts 优先取 attemptsStarted（执行次数），缺失时回退 attemptsMade
    expect(byId.get('w1')!.attempts).toBe(2);
    expect(byId.get('d1')!.status).toBe('pending');
    expect(byId.get('a1')!.status).toBe('running');
    expect(byId.get('c1')).toMatchObject({ status: 'done', result: 'ok' });
    expect(byId.get('f1')).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('list 支持 state 过滤与 limit', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    await driver.enqueue('mail', {});
    const queue = h.fakeQueues.find((q) => q.name === 'mail')!;
    const mk = (id: string): Record<string, unknown> => ({
      id,
      name: 'mail',
      data: {},
      attemptsMade: 0,
      timestamp: 1000,
    });
    queue.store.set('failed', [mk('f1'), mk('f2'), mk('f3')]);

    const onlyFailed = await driver.list!({ name: 'mail', state: 'failed' });
    expect(onlyFailed).toHaveLength(3);
    expect(queue.getJobs).toHaveBeenCalledWith(['failed'], 0, 49);
    expect(await driver.list!({ name: 'mail', state: 'failed', limit: 2 })).toHaveLength(2);
  });

  it('list 不传 name 时遍历本进程已创建的队列', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    await driver.enqueue('mail', {});
    await driver.enqueue('cleanup', {});
    for (const q of h.fakeQueues) {
      q.store.set('waiting', [
        { id: `w-${q.name}`, name: q.name, data: {}, attemptsMade: 0, timestamp: 1000 },
      ]);
    }
    const records = await driver.list!();
    expect(records.map((r) => r.id).sort()).toEqual(['w-cleanup', 'w-mail']);
  });

  it('cancel 映射 job.remove（任务不存在时 no-op）', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    await driver.enqueue('mail', {});
    const queue = h.fakeQueues.find((q) => q.name === 'mail')!;
    const remove = vi.fn(async () => {});
    queue.byId.set('j1', { id: 'j1', remove });

    await driver.cancel!('mail', 'j1');
    expect(remove).toHaveBeenCalledTimes(1);
    await expect(driver.cancel!('mail', 'missing')).resolves.toBeUndefined();
  });

  it('retry 映射 job.retry（任务不存在时抛错）', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    await driver.enqueue('mail', {});
    const queue = h.fakeQueues.find((q) => q.name === 'mail')!;
    const retry = vi.fn(async () => {});
    queue.byId.set('j1', { id: 'j1', retry });

    await driver.retry!('mail', 'j1');
    expect(retry).toHaveBeenCalledTimes(1);
    await expect(driver.retry!('mail', 'missing')).rejects.toThrow(/not found/);
  });

  it('dedupId 映射为 add 的 jobId（BullMQ 存活期内同键忽略）', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    await driver.enqueue('mail', { to: 'x' }, { dedupId: 'order-confirm:1' });
    const queue = h.fakeQueues.find((q) => q.name === 'mail')!;
    expect(queue.adds[0]!.opts).toMatchObject({ jobId: 'order-confirm:1' });
  });
});
