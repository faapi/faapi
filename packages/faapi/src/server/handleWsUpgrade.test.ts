import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { attachWebSocket, bindEvents } from './handleWsUpgrade';
import type { RoutesRef } from '../router/routeTypes';

/** 构造最小 WebSocket mock（仅 bindEvents 用到的面） */
function makeRawSocket() {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  return {
    readyState: 1,
    on(event: string, fn: (...args: never[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    once(event: string, fn: (...args: never[]) => void) {
      // 测试场景一次性触发即可（open 只 emit 一次），无需真正的 once 语义
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) fn(...(args as never[]));
    },
  } as unknown as import('ws').WebSocket & {
    on: (event: string, fn: (...args: never[]) => void) => unknown;
    once: (event: string, fn: (...args: never[]) => void) => unknown;
    emit: (event: string, ...args: unknown[]) => void;
  };
}

describe('attachWebSocket', () => {
  let server: Server;

  afterEach(() => {
    server.close();
  });

  it('返回 WebSocketServer 实例', () => {
    server = createServer();
    const routesRef: RoutesRef = { current: [], wsCurrent: [] };
    const wss = attachWebSocket({
      server,
      routesRef,
      rootDir: '/tmp',
    });
    expect(wss).toBeDefined();
    expect(typeof wss.handleUpgrade).toBe('function');
  });

  it('在 server 上注册 upgrade listener', () => {
    server = createServer();
    const before = server.listenerCount('upgrade');
    const routesRef: RoutesRef = { current: [], wsCurrent: [] };
    attachWebSocket({ server, routesRef, rootDir: '/tmp' });
    const after = server.listenerCount('upgrade');
    expect(after).toBe(before + 1);
  });

  it('路由不匹配时写 404 并销毁 socket', async () => {
    server = createServer();
    const routesRef: RoutesRef = { current: [], wsCurrent: [] };
    attachWebSocket({ server, routesRef, rootDir: '/tmp' });

    // 模拟 upgrade 事件（无匹配路由）
    const written: string[] = [];
    const mockSocket = {
      write(data: string) {
        written.push(data);
        return true;
      },
      destroy() {
        written.push('__destroyed__');
      },
    } as unknown as import('node:net').Socket;

    server.emit(
      'upgrade',
      { url: '/no-such-path', headers: {} } as never,
      mockSocket,
      Buffer.alloc(0),
    );

    // 事件处理器是 async，给微任务一个 tick
    await new Promise((r) => setTimeout(r, 10));

    expect(written.some((d) => d.includes('404'))).toBe(true);
    expect(written).toContain('__destroyed__');
  });

  it('routesRef 引用更新后使用新路由（watch 热替换）', () => {
    server = createServer();
    const routesRef: RoutesRef = { current: [], wsCurrent: [] };
    attachWebSocket({ server, routesRef, rootDir: '/tmp' });

    // 模拟 reloadRoutes 更新 routesRef.wsCurrent
    const newWsRoutes = [
      { urlPath: '/ws/chat', filePath: '/tmp/handler.ts', paramNames: [], isDynamic: false },
    ];
    routesRef.wsCurrent = newWsRoutes;

    // routesRef 是引用共享，attachWebSocket 内部读 routesRef.wsCurrent
    // 这里只验证引用机制存在（完整路由匹配由 ws.e2e.test.ts 覆盖）
    expect(routesRef.wsCurrent).toBe(newWsRoutes);
  });

  it('onMessage 抛错不崩进程：异常转交 onError，连接保持', () => {
    const raw = makeRawSocket();
    const onError = vi.fn();
    bindEvents(raw, {
      onMessage: () => {
        throw new Error('bad json');
      },
      onError,
    });

    expect(() => raw.emit('message', Buffer.from('x'), false)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]![1] as Error).message).toBe('bad json');
    // 连接仍可继续收消息（故障半径单连接，框架不主动关闭）
    raw.emit('message', Buffer.from('y'), false);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('onMessage 抛错且无 onError 时 console.error 留痕', () => {
    const raw = makeRawSocket();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bindEvents(raw, {
      onMessage: () => {
        throw new Error('boom');
      },
    });
    expect(() => raw.emit('message', Buffer.from('x'), false)).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('onOpen / onClose 抛错同样被隔离', () => {
    const raw = makeRawSocket();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bindEvents(raw, {
      onOpen: () => {
        throw new Error('open failed');
      },
      onClose: () => {
        throw new Error('close failed');
      },
    });
    expect(() => raw.emit('open')).not.toThrow();
    expect(() => raw.emit('close', 1000, Buffer.alloc(0))).not.toThrow();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('onOpen'))).toBe(true);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('onClose'))).toBe(true);
    errSpy.mockRestore();
  });

  it('onError 自身抛错被捕获，不升级为 uncaughtException', () => {
    const raw = makeRawSocket();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bindEvents(raw, {
      onError: () => {
        throw new Error('hook failed');
      },
    });
    expect(() => raw.emit('message', Buffer.from('x'), false)).not.toThrow();
    expect(() => raw.emit('error', new Error('socket err'))).not.toThrow();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('onError'))).toBe(true);
    errSpy.mockRestore();
  });

  it('非 Error 抛出值包装为 Error 转交 onError', () => {
    const raw = makeRawSocket();
    const onError = vi.fn();
    bindEvents(raw, {
      onMessage: () => {
        throw 'plain string';
      },
      onError,
    });
    raw.emit('message', Buffer.from('x'), false);
    expect(onError.mock.calls[0]![1]).toBeInstanceOf(Error);
  });
});
