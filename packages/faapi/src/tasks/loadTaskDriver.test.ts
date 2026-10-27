import { describe, it, expect } from 'vitest';
import { loadTaskDriver } from './loadTaskDriver';
import type { TaskDriver } from './driverTypes';

describe('loadTaskDriver', () => {
  it('未配置 driver（undefined）抛错并提示配置方式', async () => {
    await expect(loadTaskDriver(undefined, undefined)).rejects.toThrow(/config\.task\.driver/);
  });

  it("'memory' 无内置实现——落入未知驱动通用报错（不做残留特判）", async () => {
    await expect(loadTaskDriver('memory', undefined)).rejects.toThrow(/Unknown task driver/);
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
