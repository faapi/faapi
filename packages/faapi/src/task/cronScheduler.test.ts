import { describe, it, expect, vi } from 'vitest';
import { createCronScheduler } from './cronScheduler';
import { createTaskRegistry } from './taskRegistry';
import type { TaskMetadata } from './taskTypes';

describe('createCronScheduler', () => {
  it('到点自动 enqueue 对应任务（秒级 cron），投递携带多实例防重幂等键', async () => {
    const registry = createTaskRegistry();
    const tasks: TaskMetadata[] = [
      { name: 'tick', filePath: 'dist/tasks/tick/task.js', cron: '*/1 * * * * *' },
      { name: 'nocr', filePath: 'dist/tasks/nocr/task.js' },
    ];
    registry.hydrate(tasks);
    const enqueue = vi.fn(async () => ({ id: 'x' }));
    const scheduler = createCronScheduler(registry, enqueue);
    scheduler.start();
    await vi.waitFor(
      () => {
        expect(enqueue).toHaveBeenCalledWith('tick', {
          dedupId: expect.stringMatching(/^cron:tick:\d{4}-\d{2}-\d{2}T/),
        });
      },
      { timeout: 10_000 },
    );
    const names = enqueue.mock.calls.map((c) => (c as unknown[])[0] as string);
    expect(names).not.toContain('nocr');
    scheduler.stop();
  });

  it('两次触发的 dedupId 时间窗不同（各自计划触发时刻）', async () => {
    const registry = createTaskRegistry();
    registry.hydrate([{ name: 'tick', filePath: 'd.js', cron: '*/1 * * * * *' }]);
    const keys: string[] = [];
    const enqueue = vi.fn(async (_name: string, opts: { dedupId?: string }) => {
      keys.push(opts.dedupId!);
      return { id: 'x' };
    });
    const scheduler = createCronScheduler(registry, enqueue);
    scheduler.start();
    // 真实时钟时序：慢环境（CI 高负载）下 3s 窗口可能只触发 1 次——放宽到 10s，
    // 断言语义不变（每秒 cron 重复触发 + dedupId 时间窗不同）
    await vi.waitFor(() => expect(keys.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    scheduler.stop();
    expect(new Set(keys).size).toBeGreaterThan(1);
  });

  it('dedupId 是秒级对齐的计划槽位（毫秒为 0），不随触发抖动漂移', async () => {
    // 回归：键曾取 croner currentRun()（实际触发时刻，保留毫秒）——多实例 setTimeout
    // 毫秒级抖动导致键几乎必然不同，多实例防重失效。改为 nextRun() 计划槽位后，
    // 键秒级对齐（toISOString 恒以 .000Z 结尾）且不晚于投递时刻
    const registry = createTaskRegistry();
    registry.hydrate([{ name: 'tick', filePath: 'd.js', cron: '*/1 * * * * *' }]);
    const keys: string[] = [];
    const enqueue = vi.fn(async (_name: string, opts: { dedupId?: string }) => {
      keys.push(opts.dedupId!);
      return { id: 'x' };
    });
    const scheduler = createCronScheduler(registry, enqueue);
    scheduler.start();
    await vi.waitFor(() => expect(keys.length).toBeGreaterThanOrEqual(1), { timeout: 10_000 });
    scheduler.stop();
    const slotMs = keys.map((k) => new Date(k.split(':').slice(2).join(':')).getMilliseconds());
    for (const ms of slotMs) {
      expect(ms).toBe(0);
    }
  });

  it('stop 后不再投递', async () => {
    const registry = createTaskRegistry();
    registry.hydrate([{ name: 'tick', filePath: 'd.js', cron: '*/1 * * * * *' }]);
    let count = 0;
    const enqueue = vi.fn(async () => {
      count += 1;
      return { id: 'x' };
    });
    const scheduler = createCronScheduler(registry, enqueue);
    scheduler.start();
    await vi.waitFor(() => expect(count).toBeGreaterThan(0), { timeout: 10_000 });
    scheduler.stop();
    const atStop = count;
    await new Promise((r) => setTimeout(r, 1300));
    expect(count).toBe(atStop);
  });

  it('非法 cron 表达式启动时抛错（不静默跳过）', () => {
    const registry = createTaskRegistry();
    registry.hydrate([{ name: 'bad', filePath: 'd.js', cron: 'not-a-cron' }]);
    const scheduler = createCronScheduler(registry, async () => ({ id: 'x' }));
    expect(() => scheduler.start()).toThrow();
  });
});
