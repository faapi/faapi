import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * pg-boss 驱动单测：mock 'pg-boss' 包，验证 faapi TaskDriver 语义到 pg-boss API 的映射
 * （真实连接行为由 pg-boss 自身测试保证；本包验证的是适配层）
 */

// vi.mock 工厂被提升——实例收集器经 vi.hoisted 共享
const h = vi.hoisted(() => {
  const fakeBosses: Array<{
    start: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    work: ReturnType<typeof vi.fn>;
    offWork: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    createQueue: ReturnType<typeof vi.fn>;
    sent: Array<{ name: string; data: unknown; options: unknown }>;
    workHandlers: Array<{
      options: Record<string, unknown>;
      handler: (jobs: unknown[]) => Promise<void>;
    }>;
  }> = [];
  let sendCounter = 0;
  let workerCounter = 0;
  let failStartCounter = 0;
  return {
    fakeBosses,
    counters: {
      get send() {
        return sendCounter;
      },
      set send(v: number) {
        sendCounter = v;
      },
      get worker() {
        return workerCounter;
      },
      set worker(v: number) {
        workerCounter = v;
      },
      get failStart() {
        return failStartCounter;
      },
      set failStart(v: number) {
        failStartCounter = v;
      },
    },
  };
});

vi.mock('pg-boss', () => {
  class FakeBoss {
    constructor() {
      h.fakeBosses.push(this as never);
    }
    start = vi.fn(async () => {
      if (h.counters.failStart > 0) {
        h.counters.failStart -= 1;
        throw new Error('db down');
      }
    });
    send = vi.fn(async (name: string, data: unknown, options: unknown) => {
      (this as never as { sent: unknown[] }).sent.push({ name, data, options });
      h.counters.send += 1;
      return `pgb-${h.counters.send}`;
    });
    work = vi.fn(
      async (
        _name: string,
        options: Record<string, unknown>,
        handler: (jobs: unknown[]) => Promise<void>,
      ) => {
        (this as never as { workHandlers: unknown[] }).workHandlers.push({ options, handler });
        h.counters.worker += 1;
        return `worker-${h.counters.worker}`;
      },
    );
    offWork = vi.fn(async (_idOrOptions?: string | Record<string, unknown>) => {});
    stop = vi.fn(async () => {});
    cancel = vi.fn(async (_name: string, _id: string) => {});
    resume = vi.fn(async (_name: string, _id: string) => {});
    createQueue = vi.fn(async (_name: string) => {});
    sent: Array<{ name: string; data: unknown; options: unknown }> = [];
    workHandlers: Array<{
      options: Record<string, unknown>;
      handler: (jobs: unknown[]) => Promise<void>;
    }> = [];
  }
  return { default: FakeBoss };
});

import { createPgBossDriver } from './index';

const fakeBosses = () => h.fakeBosses;

beforeEach(() => {
  h.fakeBosses.length = 0;
  h.counters.send = 0;
  h.counters.worker = 0;
  h.counters.failStart = 0;
});

describe('createPgBossDriver', () => {
  it('enqueue 映射为 boss.send（retries → retryLimit/retryBackoff，delayMs → startAfter）', async () => {
    const driver = createPgBossDriver({ connectionString: 'postgres://localhost/test' });
    const id = await driver.enqueue('mail', { to: 'a@b.c' }, { retries: 3 });
    const boss = fakeBosses()[0]!;
    expect(boss.start).toHaveBeenCalled();
    expect(boss.send).toHaveBeenCalledWith(
      'mail',
      { to: 'a@b.c' },
      expect.objectContaining({ retryLimit: 3, retryBackoff: true }),
    );
    expect(id).toBe('pgb-1');
  });

  it('delayMs 转换为 startAfter 时间点', async () => {
    const driver = createPgBossDriver();
    const before = Date.now();
    await driver.enqueue('mail', {}, { delayMs: 5000 });
    const boss = fakeBosses()[0]!;
    const options = boss.sent[0]!.options as { startAfter: Date };
    expect(options.startAfter.getTime()).toBeGreaterThanOrEqual(before + 5000);
  });

  it('startWorker 注册 boss.work（batchSize = concurrency），process 收到映射后的 job', async () => {
    const driver = createPgBossDriver();
    const process = vi.fn(async () => 'ok');
    await driver.startWorker('mail', { concurrency: 4, process });
    const boss = fakeBosses()[0]!;
    expect(boss.work).toHaveBeenCalledWith(
      'mail',
      expect.objectContaining({ batchSize: 4, includeMetadata: true }),
      expect.any(Function),
    );

    const handler = boss.workHandlers[0]!.handler;
    await handler([
      { id: 'j1', data: { to: 'x' }, retryCount: 0 },
      { id: 'j2', data: { to: 'y' }, retryCount: 2 },
    ]);
    expect(process).toHaveBeenCalledTimes(2);
    expect(process).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'j1', name: 'mail', payload: { to: 'x' }, attempt: 1 }),
    );
    // retryCount（0 起）→ attempt（1 起）
    expect(process).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 3 }));
  });

  it('process 抛错向外抛出（pg-boss 记失败并按 retryLimit 重试）', async () => {
    const driver = createPgBossDriver();
    const process = vi.fn(async () => {
      throw new Error('boom');
    });
    await driver.startWorker('flaky', { concurrency: 1, process });
    const boss = fakeBosses()[0]!;
    const handler = boss.workHandlers[0]!.handler;
    await expect(handler([{ id: 'j1', data: null, retryCount: 0 }])).rejects.toThrow('boom');
  });

  it('stop 调用 offWork + boss.stop({ close: true, graceful: true })，之后 enqueue 拒绝新任务', async () => {
    const driver = createPgBossDriver();
    await driver.enqueue('a', {});
    await driver.startWorker('a', { concurrency: 1, process: async () => 1 });
    await driver.stop(5000);
    const boss = fakeBosses()[0]!;
    expect(boss.offWork).toHaveBeenCalledWith('worker-1');
    expect(boss.stop).toHaveBeenCalledWith(
      expect.objectContaining({ close: true, graceful: true }),
    );
    await expect(driver.enqueue('a', {})).rejects.toThrow('stopped');
  });

  it('stop 后 abort 在跑任务的 signal（run 可感知停机退出）', async () => {
    const driver = createPgBossDriver();
    const captured: AbortSignal[] = [];
    const process = vi.fn(async (job: { signal: AbortSignal }) => {
      captured.push(job.signal);
      await new Promise(() => {}); // 挂起：模拟任务仍在执行
    });
    await driver.startWorker('a', { concurrency: 1, process });
    const boss = fakeBosses()[0]!;
    void boss.workHandlers[0]!.handler([{ id: 'j1', data: null, retryCount: 0 }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(captured[0]!.aborted).toBe(false);
    // fake boss.stop 立即完成 → 停止结束后对残留 in-flight 兜底 abort
    await driver.stop(20);
    expect(captured[0]!.aborted).toBe(true);
  });

  it('stopWorkers 仅 offWork 不断连接（reload 场景），可重新注册', async () => {
    const driver = createPgBossDriver();
    await driver.startWorker('a', { concurrency: 1, process: async () => 1 });
    await driver.stopWorkers?.();
    const boss = fakeBosses()[0]!;
    expect(boss.stop).not.toHaveBeenCalled();
    expect(boss.offWork).toHaveBeenCalledWith('worker-1');
    await driver.startWorker('a', { concurrency: 1, process: async () => 1 });
    expect(boss.work).toHaveBeenCalledTimes(2);
  });

  it('cancel 映射 boss.cancel(name, id)（v10 需要显式队列名）', async () => {
    const driver = createPgBossDriver();
    await driver.enqueue('mail', {});
    const boss = fakeBosses()[0]!;
    await driver.cancel!('mail', 'j1');
    expect(boss.cancel).toHaveBeenCalledWith('mail', 'j1');
  });

  it('retry 映射 boss.resume(name, id)（仅 cancelled 任务可恢复）', async () => {
    const driver = createPgBossDriver();
    await driver.enqueue('mail', {});
    const boss = fakeBosses()[0]!;
    await driver.retry!('mail', 'j1');
    expect(boss.resume).toHaveBeenCalledWith('mail', 'j1');
  });

  it('list 未实现——pg-boss v10 无批量列出 jobs 的公开 API（能力缺口显式）', async () => {
    const driver = createPgBossDriver();
    expect(driver.list).toBeUndefined();
  });

  it('stop 后 cancel/retry 显式拒绝（驱动连接已关闭）', async () => {
    const driver = createPgBossDriver();
    await driver.enqueue('mail', {});
    await driver.stop(1000);
    await expect(driver.cancel!('mail', 'j1')).rejects.toThrow(/stopped/);
    await expect(driver.retry!('mail', 'j1')).rejects.toThrow(/stopped/);
  });

  it('dedupId 映射为 send 自定义 id（pg-boss 要求 UUID 格式，驱动内确定性转换）', async () => {
    const driver = createPgBossDriver();
    await driver.enqueue('mail', { to: 'x' }, { dedupId: 'cron:mail:2026-09-14T10:00:00.000Z' });
    const boss = fakeBosses()[0]!;
    const options = boss.sent[0]!.options as { id: string };
    // 确定性 UUID：任意字符串键 → 合法 UUID 形状，同键必同 UUID
    expect(options.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const driver2 = createPgBossDriver();
    await driver2.enqueue('mail', { to: 'x' }, { dedupId: 'cron:mail:2026-09-14T10:00:00.000Z' });
    const options2 = fakeBosses()[1]!.sent[0]!.options as { id: string };
    expect(options2.id).toBe(options.id);
    // 不同键不同 UUID
    await driver2.enqueue('mail', { to: 'x' }, { dedupId: 'cron:mail:2026-09-14T10:01:00.000Z' });
    const options3 = fakeBosses()[1]!.sent[1]!.options as { id: string };
    expect(options3.id).not.toBe(options.id);
  });

  it('重复投递（pg-boss 冲突返回 null）时返回幂等键对应的确定性 id', async () => {
    const driver = createPgBossDriver();
    // 第一次正常返回
    const first = await driver.enqueue('mail', { to: 'x' }, { dedupId: 'key-1' });
    expect(first).toBe('pgb-1');
    const boss = fakeBosses()[0]!;
    // 第二次同键：pg-boss ON CONFLICT DO NOTHING → send 返回 null → 返回幂等键映射 id
    boss.send = vi.fn(async () => null) as never;
    const second = await driver.enqueue('mail', { to: 'x' }, { dedupId: 'key-1' });
    expect(second).toBeTypeOf('string');
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('enqueue 首次投递前自动 createQueue（pg-boss v10 对未创建队列 send 返回 null）', async () => {
    const driver = createPgBossDriver();
    await driver.enqueue('mail', { to: 'x' });
    const boss = fakeBosses()[0]!;
    expect(boss.createQueue).toHaveBeenCalledTimes(1);
    expect(boss.createQueue).toHaveBeenCalledWith('mail');
    // 建队列先于投递：先 ensureQueue 再 send
    expect(boss.createQueue.mock.invocationCallOrder[0]).toBeLessThan(
      boss.send.mock.invocationCallOrder[0],
    );
  });

  it('同名任务第二次 enqueue 不重复 createQueue（进程内缓存短路）', async () => {
    const driver = createPgBossDriver();
    await driver.enqueue('mail', { to: 'x' });
    await driver.enqueue('mail', { to: 'y' });
    const boss = fakeBosses()[0]!;
    expect(boss.createQueue).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledTimes(2);
  });

  it('不同任务名各自建队列一次', async () => {
    const driver = createPgBossDriver();
    await driver.enqueue('mail', {});
    await driver.enqueue('log-analysis', {});
    await driver.enqueue('mail', {});
    const boss = fakeBosses()[0]!;
    expect(boss.createQueue).toHaveBeenCalledTimes(2);
    expect(boss.createQueue).toHaveBeenNthCalledWith(1, 'mail');
    expect(boss.createQueue).toHaveBeenNthCalledWith(2, 'log-analysis');
  });

  it('startWorker 同样先 createQueue 再 work（启动即对任务清单建齐队列）', async () => {
    const driver = createPgBossDriver();
    await driver.startWorker('mail', { concurrency: 1, process: async () => 1 });
    const boss = fakeBosses()[0]!;
    expect(boss.createQueue).toHaveBeenCalledWith('mail');
    expect(boss.createQueue.mock.invocationCallOrder[0]).toBeLessThan(
      boss.work.mock.invocationCallOrder[0],
    );
    // enqueue 与 startWorker 共享缓存：混合调用不重复建队列
    await driver.enqueue('mail', {});
    expect(boss.createQueue).toHaveBeenCalledTimes(1);
  });

  it('send 返回 null 且无 dedupId 时仍显式抛错（ensureQueue 后 null 只能是异常）', async () => {
    const driver = createPgBossDriver();
    await driver.enqueue('mail', {}); // 先建队列并缓存
    const boss = fakeBosses()[0]!;
    boss.send = vi.fn(async () => null) as never;
    await expect(driver.enqueue('mail', {})).rejects.toThrow('pg-boss send failed');
  });

  it('createQueue 抛错时 enqueue 向外传播底层错误（不静默降级）', async () => {
    const driver = createPgBossDriver();
    await driver.enqueue('warmup', {}); // 惰性建连：先触发一次投递让 FakeBoss 实例化
    const boss = fakeBosses()[0]!;
    boss.createQueue = vi.fn(async () => {
      throw new Error('connection refused');
    }) as never;
    await expect(driver.enqueue('mail', {})).rejects.toThrow('connection refused');
    expect(boss.send).toHaveBeenCalledTimes(1); // 仅 warmup 那次，失败投递未触达 send
    // 失败不入缓存：下次投递重试建队列
    boss.createQueue = vi.fn(async () => {}) as never;
    await driver.enqueue('mail', {});
    expect(boss.send).toHaveBeenCalledTimes(2);
  });

  it('并发首次投递同名任务只触发一次 createQueue（in-flight 去重）', async () => {
    const driver = createPgBossDriver();
    await Promise.all([
      driver.enqueue('mail', { to: 'a' }),
      driver.enqueue('mail', { to: 'b' }),
      driver.enqueue('mail', { to: 'c' }),
    ]);
    const boss = fakeBosses()[0]!;
    expect(boss.createQueue).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledTimes(3);
  });

  it('并发首次调用共享同一次 boss.start（in-flight 建连去重，半启动实例不外借）', async () => {
    const driver = createPgBossDriver();
    await Promise.all([
      driver.enqueue('mail', { to: 'a' }),
      driver.enqueue('mail', { to: 'b' }),
      driver.startWorker('mail', { concurrency: 1, process: async () => 1 }),
    ]);
    // 单实例：第二个调用等待同一 start 完成，而不是跳过 start 直接跑 SQL
    expect(fakeBosses()).toHaveLength(1);
    expect(fakeBosses()[0]!.start).toHaveBeenCalledTimes(1);
    expect(fakeBosses()[0]!.send).toHaveBeenCalledTimes(2);
    expect(fakeBosses()[0]!.work).toHaveBeenCalledTimes(1);
  });

  it('boss.start 失败后下次调用重建实例（坏实例不入缓存，可重试）', async () => {
    const driver = createPgBossDriver();
    h.counters.failStart = 1;
    await expect(driver.enqueue('mail', {})).rejects.toThrow('db down');
    // 失败后 boss 保持 null：下次调用重新 new PgBoss + start（而不是复用坏实例）
    await driver.enqueue('mail', {});
    expect(fakeBosses()).toHaveLength(2);
    expect(fakeBosses()[1]!.start).toHaveBeenCalledTimes(1);
    expect(fakeBosses()[1]!.send).toHaveBeenCalledTimes(1);
  });
});
