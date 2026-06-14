import { describe, it, expect } from 'vitest';
import { scanRoutes } from './scanRoutes';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/api-basic');

describe('scanRoutes', () => {
  it('扫描 fixtures 目录生成正确的路由清单', async () => {
    const { routes, wsRoutes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);

    // auth/login(GET+POST) + user(GET+POST) + user/[id](GET) + novel/list(GET) + redirect(GET) + health(GET+HEAD)
    // + admin/dashboard(GET) + admin/profile(GET) + admin/broken(GET)
    // + cookie/read(GET) + cookie/set(GET) + cookie/delete(GET)
    // + error/throw(GET) + error/validate(GET+POST)
    // + sse(GET) + inject(GET)
    expect(routes).toHaveLength(18);
    // chat + room/[id] + ws-auth + ws-chain/inner
    expect(wsRoutes).toHaveLength(4);

    // 检查 auth/login GET
    const loginGet = routes.find((r) => r.method === 'GET' && r.urlPath === '/api/auth/login');
    expect(loginGet).toBeDefined();
    expect(loginGet!.filePath).toBe('api/auth/login/handler.ts');
    expect(loginGet!.isDynamic).toBe(false);
    expect(loginGet!.paramNames).toEqual([]);

    // 检查 auth/login POST
    const loginPost = routes.find((r) => r.method === 'POST' && r.urlPath === '/api/auth/login');
    expect(loginPost).toBeDefined();
    expect(loginPost!.filePath).toBe('api/auth/login/handler.ts');
    expect(loginPost!.isDynamic).toBe(false);

    // 检查 user/[id] GET
    const userGet = routes.find((r) => r.method === 'GET' && r.urlPath === '/api/user/:id');
    expect(userGet).toBeDefined();
    expect(userGet!.filePath).toBe('api/user/[id]/handler.ts');
    expect(userGet!.isDynamic).toBe(true);
    expect(userGet!.paramNames).toEqual(['id']);

    // 检查 novel/list GET
    const novelGet = routes.find((r) => r.method === 'GET' && r.urlPath === '/api/novel/list');
    expect(novelGet).toBeDefined();
    expect(novelGet!.filePath).toBe('api/novel/list/handler.ts');
    expect(novelGet!.isDynamic).toBe(false);
  });

  it('handler.ts 生成多个路由记录', async () => {
    const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);

    // health/handler.ts 导出 GET 和 HEAD
    const healthGet = routes.find((r) => r.method === 'GET' && r.urlPath === '/api/health');
    expect(healthGet).toBeDefined();
    expect(healthGet!.filePath).toBe('api/health/handler.ts');

    const healthHead = routes.find((r) => r.method === 'HEAD' && r.urlPath === '/api/health');
    expect(healthHead).toBeDefined();
    expect(healthHead!.filePath).toBe('api/health/handler.ts');
  });

  it('过滤掉非 HTTP 方法文件', async () => {
    const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
    // 所有路由的方法都应该是合法 HTTP 方法
    for (const route of routes) {
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).toContain(route.method);
    }
  });

  it('空目录返回空数组', async () => {
    const { routes, wsRoutes } = await scanRoutes(FIXTURES_DIR, ['nonexistent/**/*.ts']);
    expect(routes).toEqual([]);
    expect(wsRoutes).toEqual([]);
  });

  it('父子中间件叠加（从根到路由目录合并）', async () => {
    const tmpDir = path.join(os.tmpdir(), 'faapi-test-middleware-' + Date.now());
    fs.mkdirSync(path.join(tmpDir, 'api', 'admin', 'dashboard'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'api', 'other'), { recursive: true });

    // 根中间件（api/ 下）—— 洋葱模型单一函数
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'middlewares.ts'),
      'export default [async (ctx, next) => { ctx.root = true; await next(); }];\n' +
        "export const injectors = { rootDb: () => ({ from: 'root' }) };",
    );

    // admin 目录中间件（子级）
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'admin', 'middlewares.ts'),
      'export default [async (ctx, next) => { ctx.admin = true; await next(); }];\n' +
        "export const injectors = { adminDb: () => ({ from: 'admin' }), rootDb: () => ({ from: 'admin-override' }) };",
    );

    // admin/dashboard/handler.ts
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'admin', 'dashboard', 'handler.ts'),
      'export function GET() { return { ok: true }; }',
    );

    // other/handler.ts
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'other', 'handler.ts'),
      'export function GET() { return { ok: true }; }',
    );

    try {
      const { routes } = await scanRoutes(tmpDir, ['api/**/*.ts']);

      // admin/dashboard 应合并 root + admin 两层中间件
      const adminRoute = routes.find((r) => r.urlPath === '/api/admin/dashboard');
      expect(adminRoute).toBeDefined();
      expect(adminRoute!.middlewares).toBeDefined();
      expect(adminRoute!.middlewares!.length).toBe(2); // root + admin
      // 父级在前，子级在后
      expect(typeof adminRoute!.middlewares![0]).toBe('function');
      expect(typeof adminRoute!.middlewares![1]).toBe('function');

      // 注入器合并：子级覆盖父级同名
      expect(adminRoute!.injectors).toBeDefined();
      expect(adminRoute!.injectors!.rootDb).toBeInstanceOf(Function);
      expect(adminRoute!.injectors!.adminDb).toBeInstanceOf(Function);
      // 子级覆盖父级：rootDb 应该是 admin 的版本
      expect(await adminRoute!.injectors!.rootDb({} as any)).toEqual({ from: 'admin-override' });

      // other 只有根中间件
      const otherRoute = routes.find((r) => r.urlPath === '/api/other');
      expect(otherRoute).toBeDefined();
      expect(otherRoute!.middlewares).toBeDefined();
      expect(otherRoute!.middlewares!.length).toBe(1); // 只有 root
      expect(otherRoute!.injectors!.rootDb).toBeInstanceOf(Function);
      expect(otherRoute!.injectors!.adminDb).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('catch-all 路由扫描（handler.ts）', async () => {
    const tmpDir = path.join(os.tmpdir(), 'faapi-test-catchall-' + Date.now());
    fs.mkdirSync(path.join(tmpDir, 'api', 'shop', '[...slug]'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'shop', '[...slug]', 'handler.ts'),
      'export function GET() { return { ok: true }; }',
    );

    try {
      const { routes } = await scanRoutes(tmpDir, ['api/**/*.ts']);
      const catchAllRoute = routes.find((r) => r.isCatchAll);
      expect(catchAllRoute).toBeDefined();
      expect(catchAllRoute!.urlPath).toBe('/api/shop/:...slug');
      expect(catchAllRoute!.paramNames).toEqual(['slug']);
      expect(catchAllRoute!.isDynamic).toBe(true);
      expect(catchAllRoute!.isCatchAll).toBe(true);
      expect(catchAllRoute!.filePath).toBe('api/shop/[...slug]/handler.ts');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('普通动态路由不标记为 catch-all', async () => {
    const tmpDir = path.join(os.tmpdir(), 'faapi-test-no-catchall-' + Date.now());
    fs.mkdirSync(path.join(tmpDir, 'api', 'user', '[id]'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'user', '[id]', 'handler.ts'),
      'export function GET() { return { ok: true }; }',
    );

    try {
      const { routes } = await scanRoutes(tmpDir, ['api/**/*.ts']);
      const route = routes.find((r) => r.urlPath === '/api/user/:id');
      expect(route).toBeDefined();
      expect(route!.isDynamic).toBe(true);
      expect(route!.isCatchAll).toBeFalsy();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('WS 路由：扫描 fixtures 目录返回 WS 路由清单', async () => {
    const { routes, wsRoutes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);

    // HTTP 路由数量与原 scanRoutes 一致（18 条）
    expect(routes).toHaveLength(18);

    // WS 路由：chat + room/[id] + ws-auth + ws-chain/inner = 4 条
    expect(wsRoutes).toHaveLength(4);

    // 检查 /api/chat WS 路由
    const chatWs = wsRoutes.find((r) => r.urlPath === '/api/chat');
    expect(chatWs).toBeDefined();
    expect(chatWs!.filePath).toBe('api/chat/handler.ts');
    expect(chatWs!.isDynamic).toBe(false);
    expect(chatWs!.paramNames).toEqual([]);

    // 检查 /api/room/:id WS 路由（动态）
    const roomWs = wsRoutes.find((r) => r.urlPath === '/api/room/:id');
    expect(roomWs).toBeDefined();
    expect(roomWs!.filePath).toBe('api/room/[id]/handler.ts');
    expect(roomWs!.isDynamic).toBe(true);
    expect(roomWs!.paramNames).toEqual(['id']);

    // 检查 /api/ws-auth WS 路由（带握手中间件）
    const wsAuth = wsRoutes.find((r) => r.urlPath === '/api/ws-auth');
    expect(wsAuth).toBeDefined();
    expect(wsAuth!.middlewares).toBeDefined();
    expect(wsAuth!.middlewares).toHaveLength(1);

    // 检查 /api/ws-chain/inner WS 路由（父子中间件叠加）
    const wsChain = wsRoutes.find((r) => r.urlPath === '/api/ws-chain/inner');
    expect(wsChain).toBeDefined();
    expect(wsChain!.middlewares).toBeDefined();
    expect(wsChain!.middlewares).toHaveLength(2);
  });

  it('WS 路由复用同目录的中间件和注入器', async () => {
    // fixtures/api-basic/api/admin/middlewares.ts 存在
    // 在 admin 下新增 WS fixture，验证中间件合并
    const tmpDir = path.join(os.tmpdir(), 'faapi-test-ws-mw-' + Date.now());
    fs.mkdirSync(path.join(tmpDir, 'api', 'admin'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'admin', 'middlewares.ts'),
      `import type { FaapiMiddleware } from '@faapi/faapi';
       export default [async (ctx, next) => { ctx.user = { id: 1 }; await next(); }] satisfies FaapiMiddleware[];
       export const injectors = { db: () => ({ query: () => [] }) };`,
    );
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'admin', 'handler.ts'),
      'export function WS() { return { onOpen() {} }; }',
    );

    try {
      const { routes, wsRoutes } = await scanRoutes(tmpDir, ['api/**/*.ts']);
      expect(routes).toHaveLength(0); // 无 HTTP 方法导出
      expect(wsRoutes).toHaveLength(1);
      expect(wsRoutes[0].middlewares).toBeDefined();
      expect(wsRoutes[0].middlewares!.length).toBe(1);
      expect(wsRoutes[0].injectors).toBeDefined();
      expect(wsRoutes[0].injectors!.db).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handler.ts 只导出 HTTP 方法时，不生成 WS 路由', async () => {
    const tmpDir = path.join(os.tmpdir(), 'faapi-test-ws-http-only-' + Date.now());
    fs.mkdirSync(path.join(tmpDir, 'api', 'user'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'user', 'handler.ts'),
      'export function GET() { return { ok: true }; }',
    );

    try {
      const { routes, wsRoutes } = await scanRoutes(tmpDir, ['api/**/*.ts']);
      expect(routes).toHaveLength(1);
      expect(wsRoutes).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handler.ts 同时导出 HTTP 方法和 WS 时，分别生成两类路由', async () => {
    const tmpDir = path.join(os.tmpdir(), 'faapi-test-ws-mixed-' + Date.now());
    fs.mkdirSync(path.join(tmpDir, 'api', 'mixed'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'mixed', 'handler.ts'),
      `export function GET() { return { ok: true }; }
       export function WS() { return { onOpen() {} }; }`,
    );

    try {
      const { routes, wsRoutes } = await scanRoutes(tmpDir, ['api/**/*.ts']);
      expect(routes).toHaveLength(1);
      expect(routes[0].method).toBe('GET');
      expect(wsRoutes).toHaveLength(1);
      expect(wsRoutes[0].urlPath).toBe('/api/mixed');
      // 两者指向同一文件
      expect(routes[0].filePath).toBe(wsRoutes[0].filePath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
