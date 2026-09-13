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
});
