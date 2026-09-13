import { describe, it, expect, vi } from 'vitest';
import { createCronScheduler } from './cronScheduler';
import { createTaskRegistry } from './taskRegistry';
import type { TaskMetadata } from './taskTypes';

describe('createCronScheduler', () => {
  it('到点自动 enqueue 对应任务（秒级 cron）', async () => {
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
        expect(enqueue).toHaveBeenCalledWith('tick');
      },
      { timeout: 3000 },
    );
    const names = enqueue.mock.calls.map((c) => (c as unknown[])[0] as string);
    expect(names).not.toContain('nocr');
    scheduler.stop();
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
    await vi.waitFor(() => expect(count).toBeGreaterThan(0), { timeout: 3000 });
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
