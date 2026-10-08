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
  /** 组记账假 redis（defineCommand/runCommand 契约；按命令名注入返回值） */
  const fakeRedis = {
    called: [] as { command: string; args: string[] }[],
    hashes: new Map<string, Record<string, string>>(),
    commandHandler: null as null | ((command: string, args: string[]) => unknown),
    defineCommand: (name: string, _def: { numberOfKeys: number; lua: string }) => {
      fakeRedis.commands.add(name);
    },
    commands: new Set<string>(),
    runCommand: async (name: string, args: unknown[]) => {
      const argv = args.map(String);
      fakeRedis.called.push({ command: name, args: argv });
      if (fakeRedis.commandHandler) return fakeRedis.commandHandler(name, argv);
      // 缺省仅模拟成员登记 HSETNX（真实 Lua 落库——fake 同构写成员 hash）
      if (name === 'faapiGroupMemberHsetnx') {
        const [key, field, value] = argv;
        const h0 = fakeRedis.hashes.get(key) ?? {};
        if (field in h0) return 0;
        fakeRedis.hashes.set(key, { ...h0, [field]: value });
        return 1;
      }
      return [];
    },
    hset: async (key: string, data: Record<string, string | number>) => {
      const h0 = fakeRedis.hashes.get(key) ?? {};
      const entries = Object.entries(data).map(([f, v]) => [f, String(v)] as const);
      // ioredis 全量返回字符串——fake 同构（驱动按字符串解析）
      fakeRedis.hashes.set(key, { ...h0, ...Object.fromEntries(entries) });
      return entries.length;
    },
    hgetall: async (key: string) => fakeRedis.hashes.get(key) ?? {},
  };
  return {
    fakeQueues,
    fakeWorkers,
    fakeRedis,
    getAddCounter: () => ++addCounter,
    resetAddCounter: () => {
      addCounter = 0;
    },
  };
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
    /** Queue.backend.client 契约：底层 redis（组记账复用该连接） */
    backend = {
      client: Promise.resolve(h.fakeRedis),
    };
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
  h.fakeRedis.called.length = 0;
  h.fakeRedis.hashes.clear();
  h.fakeRedis.commandHandler = null;
  h.fakeRedis.commands.clear();
  h.resetAddCounter();
});

/** 组记账命令名（与驱动 defineCommand 注册名一致） */
const CMD = {
  create: 'faapiGroupCreate',
  settle: 'faapiGroupSettle',
  unsettle: 'faapiGroupUnsettle',
  hsetnx: 'faapiGroupMemberHsetnx',
};

/** settle Lua 返回行（[changed, done, failed, cancelled, total, onComplete, onFailure, ce]） */
const settleRow = (over: number[] = []) => [
  1,
  over[0] ?? 1,
  over[1] ?? 0,
  over[2] ?? 0,
  over[3] ?? 2,
  'summary',
  'fail-fast',
  over[4] ?? 0,
];

describe('createBullMQDriver 组记账', () => {
  it('enqueue 带组标识：载荷包装存储 + 成员 hash 登记幂等（HSETNX）', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    await driver.enqueue('chunks', { i: 1 }, { groupId: 'g1', dedupId: 'faapi-group:g1:1' });
    const queue = h.fakeQueues.find((q) => q.name === 'chunks')!;
    expect(queue.adds[0]!.data).toEqual({ __faapiGroup: 'g1', __faapiPayload: { i: 1 } });
    expect(h.fakeRedis.hashes.get('faapi:group-members:g1')).toEqual({ 'bm-1': 'pending' });
    // 存量路径：不带组标识不包装、不登记
    await driver.enqueue('mail', { to: 'a@b.c' });
    const mail = h.fakeQueues.find((q) => q.name === 'mail')!;
    expect(mail.adds[0]!.data).toEqual({ to: 'a@b.c' });
    expect(h.fakeRedis.hashes.has('faapi:group-members:mail')).toBe(false);
  });

  it('work 交付从载荷包装还原业务 payload 与 groupId', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    const process = vi.fn(async () => 'ok');
    await driver.startWorker('chunks', { concurrency: 1, process });
    const worker = h.fakeWorkers[0]!;
    await worker.handler({
      id: 'j1',
      data: { __faapiGroup: 'g1', __faapiPayload: { i: 1 } },
      attemptsStarted: 1,
    });
    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { i: 1 }, groupId: 'g1' }),
    );
  });

  it('getJobs 记录从载荷包装还原（payload 原始 + groupId），普通任务不带 groupId', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    // list 不传 name 遍历驱动内已建 Queue——先经 enqueue 创建 chunks 队列
    await driver.enqueue('chunks', { i: 1 }, { groupId: 'g1' });
    const queue = h.fakeQueues.find((q) => q.name === 'chunks')!;
    queue.store.set('waiting', [
      {
        id: 'j1',
        name: 'chunks',
        data: { __faapiGroup: 'g1', __faapiPayload: { i: 1 } },
        timestamp: 1700000000000,
      },
      { id: 'j2', name: 'chunks', data: { to: 'a@b.c' }, timestamp: 1700000000000 },
    ]);
    const records = await driver.list!({ name: 'chunks' });
    expect(records[0]).toMatchObject({ id: 'j1', payload: { i: 1 }, groupId: 'g1' });
    expect(records[1]!.groupId).toBeUndefined();
  });

  it('settle：Lua 原子计账调用（keys + jobId + outcome），返回行解析为快照 + isLast', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    const groups = driver.groups!;
    // 组不存在：Lua 返回 [-1] → 抛错（不静默记账）
    h.fakeRedis.commandHandler = (c) => (c === CMD.settle ? [-1] : []);
    await expect(groups.settle('g1', 'j1', 'done')).rejects.toThrow(/not found/);
    // 首落定：返回记账后行 → 快照 + isLast
    h.fakeRedis.commandHandler = (c) => (c === CMD.settle ? settleRow([1, 0, 0, 2, 0]) : []);
    const res = await groups.settle('g1', 'j1', 'done');
    expect(res).toMatchObject({
      groupId: 'g1',
      done: 1,
      failed: 0,
      cancelled: 0,
      total: 2,
      settled: 1,
      status: 'open',
      isLast: false,
      onComplete: 'summary',
      onFailure: 'fail-fast',
    });
    // 末落定：settled >= total → isLast true
    h.fakeRedis.commandHandler = (c) => (c === CMD.settle ? settleRow([2, 0, 0, 2, 0]) : []);
    const last = await groups.settle('g1', 'j2', 'done');
    expect(last).toMatchObject({ settled: 2, status: 'settled', isLast: true });
    const settleCall = h.fakeRedis.called.filter((e) => e.command === CMD.settle).at(-1)!;
    expect(settleCall.args).toEqual(['faapi:group:g1', 'faapi:group-members:g1', 'j2', 'done']);
  });

  it('create：Lua 返回 0 幂等跳过；-1 读旧声明抛参数漂移；1 首次创建', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    const groups = driver.groups!;
    const decl = {
      id: 'g1',
      task: 'chunks',
      total: 2,
      onComplete: 'summary',
      onFailure: 'fail-fast' as const,
    };
    // 首次创建（Lua 返回 1）
    h.fakeRedis.commandHandler = (c) => (c === CMD.create ? 1 : []);
    await groups.create(decl);
    const createCall = h.fakeRedis.called.find((e) => e.command === CMD.create)!;
    expect(createCall.args).toEqual([
      'faapi:group:g1',
      'faapi:group-members:g1',
      'chunks',
      '2',
      'summary',
      'fail-fast',
    ]);
    // 幂等命中（返回 0）不抛错不读旧声明
    h.fakeRedis.commandHandler = (c) => (c === CMD.create ? 0 : []);
    await groups.create(decl);
    // 参数漂移（返回 -1）→ 读旧声明抛错
    h.fakeRedis.hashes.set('faapi:group:g1', {
      task: 'chunks',
      total: '5',
      onComplete: 'other',
      onFailure: 'run-to-completion',
    });
    h.fakeRedis.commandHandler = (c) => (c === CMD.create ? -1 : []);
    await expect(groups.create(decl)).rejects.toThrow(/already exists with different options/);
  });

  it('cancelRemaining：fail-fast 取消 waiting/delayed 成员并落定；run-to-completion 为 no-op', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    const groups = driver.groups!;
    // 组快照：fail-fast
    h.fakeRedis.hashes.set('faapi:group:g1', {
      task: 'chunks',
      total: '3',
      done: '1',
      failed: '0',
      cancelled: '0',
      onComplete: 'summary',
      onFailure: 'fail-fast',
      completionEnqueued: '0',
    });
    // 成员：j2 待落定 + j3 已落定（跳过）；settle Lua 返回取消后的计数
    h.fakeRedis.hashes.set('faapi:group-members:g1', { j2: 'pending', j3: 's:done' });
    h.fakeRedis.commandHandler = (c) => (c === CMD.settle ? settleRow([1, 0, 1, 3, 0]) : []);
    const settleCalls = () => h.fakeRedis.called.filter((e) => e.command === CMD.settle);
    const remove = vi.fn(async () => {});
    // j2 waiting：remove 成功 → settle('j2','cancelled')；j3 已落定跳过
    await driver.enqueue('chunks', {}, { groupId: 'g1' }); // 触发 chunks 队列创建
    const chunksQueue = h.fakeQueues.find((q) => q.name === 'chunks')!;
    chunksQueue.byId.set('j2', { getState: async () => 'waiting', remove } as never);
    await groups.cancelRemaining('g1');
    expect(remove).toHaveBeenCalledOnce();
    const lastSettle = settleCalls().at(-1)!;
    expect(lastSettle.args.slice(-2)).toEqual(['j2', 'cancelled']);
    // 非 waiting/delayed 状态（active）不取消——成员表只留 active 成员
    chunksQueue.byId.set('j5', { getState: async () => 'active', remove: vi.fn() } as never);
    h.fakeRedis.hashes.set('faapi:group-members:g1', { j5: 'pending' });
    remove.mockClear();
    h.fakeRedis.called.length = 0;
    await groups.cancelRemaining('g1');
    expect(remove).not.toHaveBeenCalled();
    // run-to-completion：no-op（不落定成员）
    h.fakeRedis.hashes.set('faapi:group:g1', {
      task: 'chunks',
      total: '3',
      done: '0',
      failed: '0',
      cancelled: '0',
      onComplete: '',
      onFailure: 'run-to-completion',
      completionEnqueued: '0',
    });
    h.fakeRedis.called.length = 0;
    const snap = await groups.cancelRemaining('g1');
    expect(snap.onFailure).toBe('run-to-completion');
    expect(settleCalls()).toHaveLength(0);
  });

  it('unsettle 调 Lua 逆向记账；markCompletionEnqueued 写 HSET；get 解析组 hash', async () => {
    const driver = createBullMQDriver({ connection: { host: '127.0.0.1' } });
    const groups = driver.groups!;
    await groups.unsettle('g1', 'j1');
    expect(h.fakeRedis.called.some((e) => e.command === CMD.unsettle)).toBe(true);
    await groups.markCompletionEnqueued('g1');
    expect(h.fakeRedis.hashes.get('faapi:group:g1')).toMatchObject({ completionEnqueued: '1' });
    // 组不存在 → undefined
    await expect(groups.get('nope')).resolves.toBeUndefined();
    h.fakeRedis.hashes.set('faapi:group:g1', {
      task: 'chunks',
      total: '2',
      done: '2',
      failed: '0',
      cancelled: '0',
      onComplete: 'summary',
      onFailure: 'run-to-completion',
      completionEnqueued: '1',
    });
    await expect(groups.get('g1')).resolves.toMatchObject({
      status: 'settled',
      completionEnqueued: true,
      settled: 2,
      onComplete: 'summary',
    });
  });
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
