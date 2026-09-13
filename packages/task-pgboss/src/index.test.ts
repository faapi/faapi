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
    sent: Array<{ name: string; data: unknown; options: unknown }>;
    workHandlers: Array<{
      options: Record<string, unknown>;
      handler: (jobs: unknown[]) => Promise<void>;
    }>;
  }> = [];
  let sendCounter = 0;
  let workerCounter = 0;
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
    },
  };
});

vi.mock('pg-boss', () => {
  class FakeBoss {
    constructor() {
      h.fakeBosses.push(this as never);
    }
    start = vi.fn(async () => {});
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
});
