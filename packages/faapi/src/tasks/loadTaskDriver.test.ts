import { describe, it, expect } from 'vitest';
import { loadTaskDriver } from './loadTaskDriver';
import type { TaskDriver } from './driverTypes';

describe('loadTaskDriver', () => {
  it('未配置 driver（undefined）抛错并提示配置方式', async () => {
    await expect(loadTaskDriver(undefined, undefined)).rejects.toThrow(/config\.task\.driver/);
  });

  it("'memory' 显式抛错——内置内存驱动已移除，提示迁移", async () => {
    await expect(loadTaskDriver('memory', undefined)).rejects.toThrow(/removed/);
  });

  it('未知 driver 名抛错并列出支持的取值', async () => {
    await expect(loadTaskDriver('redis-fancy', undefined)).rejects.toThrow(/Unknown task driver/);
  });

  it('TaskDriver 实例原样返回（编程式自定义驱动）', async () => {
    const custom: TaskDriver = {
      enqueue: async () => 'custom-id',
      startWorker: () => {},
      stop: async () => {},
    };
    const resolved = await loadTaskDriver(custom, undefined);
    expect(resolved).toBe(custom);
  });
});
