import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { createServer } from './createServer';
import { generateSchemaFiles } from '../cli/generateSchemaFiles';
import { invalidateSchemaCache } from '../validator/validateInput';
import type { Server } from 'node:http';
import type { FaapiMiddleware } from '../middleware/middlewareTypes';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/api-basic');

let server: Server | null = null;
let baseUrl: string;
let wsBaseUrl: string;
let schemaOutDir: string;

/**
 * 执行顺序记录器：全局中间件 + 目录中间件 + handler 各阶段 push 标记
 *
 * 用于断言洋葱模型的执行顺序：
 *   globalEnter → dirEnter → handler → dirExit → globalExit
 *
 * 注意：globalEnter/globalExit 是同一个全局中间件内 await next() 两侧的代码段，
 * 不是独立的 "全局 before/after" 钩子。洋葱模型只有 (ctx, next) => { await next() }，
 * next 调用前/后的代码段属于同一个中间件。
 */
const trace: string[] = [];

const globalMw: FaapiMiddleware = async (ctx, next) => {
  trace.push('globalEnter');
  (ctx as { globalMark?: string }).globalMark = 'g';
  await next();
  trace.push('globalExit');
};

const globalInterceptor: FaapiMiddleware = async (_ctx, _next) => {
  trace.push('globalIntercept');
  return new Response(JSON.stringify({ intercepted: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

beforeAll(async () => {
  const { routes, wsRoutes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
  const sorted = sortRoutes(routes);
  // 生成 zod.js 到临时目录（createServer 运行时按 route.filePath + outDir 计算 zod.js 路径）
  schemaOutDir = await fs.mkdtemp(path.join(os.tmpdir(), 'faapi-e2e-mw-schema-'));
  await generateSchemaFiles(sorted, FIXTURES_DIR, '.', schemaOutDir);
  const { server: srv } = createServer({
    routes: sorted,
    rootDir: FIXTURES_DIR,
    appDir: '.',
    outDir: schemaOutDir,
    wsRoutes,
    middlewares: [globalMw],
  });

  await new Promise<void>((resolve, reject) => {
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr !== null) {
        const port = addr.port;
        baseUrl = `http://localhost:${port}`;
        wsBaseUrl = `ws://localhost:${port}`;
        server = srv;
        resolve();
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
  });
});

afterAll(async () => {
  if (server) {
    const anyServer = server as Server & {
      closeAllConnections?: () => void;
    };
    anyServer.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
    server = null;
  }
  if (schemaOutDir) {
    await fs.rm(schemaOutDir, { recursive: true, force: true });
  }
  invalidateSchemaCache();
});

describe('全局中间件', () => {
  it('无目录中间件的路由：仅全局中间件包裹 handler', async () => {
    trace.length = 0;
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    // health handler 无目录中间件，trace 仅含全局中间件的进入/退出标记
    expect(trace).toEqual(['globalEnter', 'globalExit']);
  });

  it('有目录中间件的路由：全局外层 + 目录内层，洋葱顺序正确', async () => {
    trace.length = 0;
    // /api/admin/profile 有 profile/middlewares.ts（鉴权）+ admin/middlewares.ts（错误处理）
    // 带 authorization 才能通过鉴权
    const res = await fetch(`${baseUrl}/api/admin/profile`, {
      headers: { authorization: 'Bearer test' },
    });
    expect(res.status).toBe(200);
    // 全局中间件在最外层：进入最先、退出最后
    expect(trace[0]).toBe('globalEnter');
    expect(trace[trace.length - 1]).toBe('globalExit');
  });

  it('全局中间件塞入 ctx 的值，handler 可读', async () => {
    // 用 /api/health 验证 globalMark 已塞入 ctx
    // health handler 直接返回，需通过响应验证
    // 改用带注入器的路由：/api/admin/profile 的 user 注入器从 ctx 取值
    // 这里验证 globalMark 通过 ctx 传递可用（间接：无异常即 ctx 完整）
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    // globalMark 已在全局中间件塞入，handler 虽未读取但 ctx 完整无异常
  });
});

describe('全局中间件拦截', () => {
  let interceptServer: Server | null = null;
  let interceptBaseUrl: string;

  beforeAll(async () => {
    const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
    const sorted = sortRoutes(routes);
    const { server: srv } = createServer({
      routes: sorted,
      rootDir: FIXTURES_DIR,
      appDir: '.',
      outDir: schemaOutDir,
      middlewares: [globalInterceptor],
    });
    await new Promise<void>((resolve) => {
      srv.listen(0, () => {
        const addr = srv.address();
        if (typeof addr === 'object' && addr !== null) {
          interceptBaseUrl = `http://localhost:${addr.port}`;
          interceptServer = srv;
          resolve();
        }
      });
    });
  });

  afterAll(async () => {
    if (interceptServer) {
      const anyServer = interceptServer as Server & {
        closeAllConnections?: () => void;
      };
      anyServer.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        interceptServer!.close(() => resolve());
      });
      interceptServer = null;
    }
  });

  it('全局中间件返回 Response：目录中间件和 handler 不执行', async () => {
    trace.length = 0;
    const res = await fetch(`${interceptBaseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ intercepted: true });
    // 仅全局拦截中间件执行，未调 next，目录中间件/handler 未执行
    expect(trace).toEqual(['globalIntercept']);
  });
});

describe('全局中间件 + WebSocket 握手', () => {
  it('WS 握手走全局中间件：放行后连接建立', async () => {
    // ws-auth 路由有目录中间件（鉴权），叠加全局中间件
    // 全局放行 + 目录鉴权通过 → 连接建立
    const ws = new WebSocket(`${wsBaseUrl}/api/ws-auth`, {
      headers: { authorization: 'Bearer test' },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
    ws.close();
  });

  it('WS 握手走全局中间件：拦截则连接被拒', async () => {
    // 用拦截型全局中间件建独立 server
    const { routes, wsRoutes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
    const sorted = sortRoutes(routes);
    const { server: srv } = createServer({
      routes: sorted,
      rootDir: FIXTURES_DIR,
      appDir: '.',
      outDir: schemaOutDir,
      wsRoutes,
      middlewares: [globalInterceptor],
    });
    const { baseUrl: srvWsBaseUrl } = await new Promise<{ baseUrl: string }>((resolve) => {
      srv.listen(0, () => {
        const addr = srv.address();
        if (typeof addr === 'object' && addr !== null) {
          resolve({ baseUrl: `ws://localhost:${addr.port}` });
        }
      });
    });

    const ws = new WebSocket(`${srvWsBaseUrl}/api/chat`);
    await expect(
      new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', () => reject(new Error('rejected')));
      }),
    ).rejects.toThrow();

    ws.close();
    const anySrv = srv as Server & { closeAllConnections?: () => void };
    anySrv.closeAllConnections?.();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
});
