import { describe, it, expect } from 'vitest';
import {
  createLogger,
  configureLogging,
  flushLogging,
  createRunHub,
  RunConflictError,
} from './index';

/**
 * 主入口公开导出防回归（src/index.ts）
 *
 * 背景：6.9.0 发版时 flushLogging 只在 logger.ts 模块内导出、漏加主入口——
 * 模块级测试全绿但发布包 import('@faapi/faapi').flushLogging 为 undefined。
 * 公开导出的函数必须有入口级断言兜底。
 */

describe('主入口公开导出（logger）', () => {
  it('createLogger / configureLogging / flushLogging 均为可调用导出', () => {
    expect(typeof createLogger).toBe('function');
    expect(typeof configureLogging).toBe('function');
    expect(typeof flushLogging).toBe('function');
  });

  it('flushLogging 无文件管道时 resolve（no-op，不在宿主目录产生副作用）', async () => {
    configureLogging(undefined);
    await expect(flushLogging()).resolves.toBeUndefined();
  });
});

describe('主入口公开导出（runHub）', () => {
  it('createRunHub 可调用、RunConflictError 为类导出', () => {
    expect(typeof createRunHub).toBe('function');
    expect(typeof RunConflictError).toBe('function');
  });

  it('createRunHub 产物具备完整 hub API 形状', () => {
    const hub = createRunHub<string>();
    expect(typeof hub.start).toBe('function');
    expect(typeof hub.subscribe).toBe('function');
    expect(typeof hub.publishExternal).toBe('function');
    expect(typeof hub.abort).toBe('function');
    expect(typeof hub.isActive).toBe('function');
  });
});
