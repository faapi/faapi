import { describe, it, expect, vi } from 'vitest';
import type { Server } from 'node:http';
import type { RequestHandler, UpgradeHandler } from '../config/pluginTypes';
import { applyPluginWrappers } from './startServer';

/** 构造一个 mock server，记录 listeners 并支持 removeAllListeners/on */
function createMockServer(requestListener?: RequestHandler, upgradeListener?: UpgradeHandler) {
  const requestListeners: RequestHandler[] = requestListener ? [requestListener] : [];
  const upgradeListeners: UpgradeHandler[] = upgradeListener ? [upgradeListener] : [];

  return {
    listeners(event: string) {
      if (event === 'request') return [...requestListeners];
      if (event === 'upgrade') return [...upgradeListeners];
      return [];
    },
    removeAllListeners(event: string) {
      if (event === 'request') requestListeners.length = 0;
      if (event === 'upgrade') upgradeListeners.length = 0;
    },
    on(event: string, cb: never) {
      if (event === 'request') requestListeners.push(cb as RequestHandler);
      if (event === 'upgrade') upgradeListeners.push(cb as UpgradeHandler);
    },
    _requestListeners: requestListeners,
    _upgradeListeners: upgradeListeners,
  } as unknown as Server & {
    _requestListeners: RequestHandler[];
    _upgradeListeners: UpgradeHandler[];
  };
}

describe('applyPluginWrappers', () => {
  it('空 handlerWrappers 不改变 request listener', () => {
    const original = vi.fn() as unknown as RequestHandler;
    const server = createMockServer(original);
    applyPluginWrappers(server, [], []);
    expect(server._requestListeners).toHaveLength(1);
    expect(server._requestListeners[0]).toBe(original);
  });

  it('有 handlerWrappers 时按顺序嵌套包装', () => {
    const original = vi.fn() as unknown as RequestHandler;
    const wrapped1 = vi.fn() as unknown as RequestHandler;
    const wrapped2 = vi.fn() as unknown as RequestHandler;
    const wrap1 = vi.fn(() => wrapped1);
    const wrap2 = vi.fn(() => wrapped2);
    const server = createMockServer(original);
    applyPluginWrappers(server, [wrap1, wrap2] as never, []);

    // 数组顺序 [wrap1, wrap2]：wrap1(original) → wrapped1, wrap2(wrapped1) → wrapped2
    expect(wrap1).toHaveBeenCalledWith(original);
    expect(wrap2).toHaveBeenCalledWith(wrapped1);
    expect(server._requestListeners).toHaveLength(1);
    expect(server._requestListeners[0]).toBe(wrapped2);
  });

  it('空 upgradeWrappers 不改变 upgrade listener', () => {
    const original = vi.fn() as unknown as UpgradeHandler;
    const server = createMockServer(undefined, original);
    applyPluginWrappers(server, [], []);
    expect(server._upgradeListeners).toHaveLength(1);
    expect(server._upgradeListeners[0]).toBe(original);
  });

  it('有 upgradeWrappers 时按顺序嵌套包装', () => {
    const original = vi.fn() as unknown as UpgradeHandler;
    const wrapped = vi.fn() as unknown as UpgradeHandler;
    const wrap = vi.fn(() => wrapped);
    const server = createMockServer(undefined, original);
    applyPluginWrappers(server, [], [wrap] as never);

    expect(wrap).toHaveBeenCalledWith(original);
    expect(server._upgradeListeners).toHaveLength(1);
    expect(server._upgradeListeners[0]).toBe(wrapped);
  });

  it('无 request listener 时 handlerWrappers 安全跳过', () => {
    const server = createMockServer();
    const wrap = vi.fn();
    expect(() => applyPluginWrappers(server, [wrap] as never, [])).not.toThrow();
    expect(server._requestListeners).toHaveLength(0);
  });

  it('无 upgrade listener 时 upgradeWrappers 接收 undefined', () => {
    const server = createMockServer();
    const wrapped = vi.fn() as unknown as UpgradeHandler;
    const wrap = vi.fn(() => wrapped);
    applyPluginWrappers(server, [], [wrap] as never);
    expect(wrap).toHaveBeenCalledWith(undefined);
    expect(server._upgradeListeners[0]).toBe(wrapped);
  });

  it('upgrade 包装结果为 undefined 时不注册', () => {
    const server = createMockServer();
    const wrap = vi.fn(() => undefined);
    applyPluginWrappers(server, [], [wrap] as never);
    expect(server._upgradeListeners).toHaveLength(0);
  });
});
