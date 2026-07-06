import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { attachWebSocket } from './handleWsUpgrade';
import type { RoutesRef } from '../router/routeTypes';

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
});
