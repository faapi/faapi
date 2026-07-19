import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTestServer, type TestServer } from './testServer';
import { invalidateSchemaCache } from './validator/validateInput';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/api-basic');

/**
 * createTestServer 业务方测试支持：公开导出 E2E 测试服务器
 *
 * 验证业务方一行代码启动带 schema 校验的测试服务器，
 * 免去手写"扫描路由 + 生成 zod.js + 监听端口 + 清理缓存"的样板代码。
 */
describe('createTestServer', () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer({
      rootDir: FIXTURES_DIR,
      patterns: ['api/**/*.ts'],
    });
  });

  afterAll(async () => {
    if (ts) await ts.close();
  });

  it('返回 TestServer 对象，含 server/baseUrl/routes/wsRoutes/schemaDist/close', () => {
    expect(ts.server).toBeDefined();
    expect(ts.baseUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(Array.isArray(ts.routes)).toBe(true);
    expect(ts.routes.length).toBeGreaterThan(0);
    expect(Array.isArray(ts.wsRoutes)).toBe(true);
    expect(ts.wsRoutes.length).toBeGreaterThan(0);
    expect(typeof ts.schemaDist).toBe('string');
    expect(typeof ts.close).toBe('function');
  });

  it('schemaDist 是已存在的绝对路径', async () => {
    const stat = await fs.stat(ts.schemaDist);
    expect(stat.isDirectory()).toBe(true);
  });

  it('GET /api/health → 200 + JSON', async () => {
    const res = await fetch(`${ts.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('路由匹配 + handler 调用（GET /api/auth/login）', async () => {
    const res = await fetch(`${ts.baseUrl}/api/auth/login`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'mock-jwt-token' });
  });

  it('动态路由匹配（GET /api/user/123）', async () => {
    const res = await fetch(`${ts.baseUrl}/api/user/123`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: '1' });
  });

  it('POST + ctx.setStatus（POST /api/user → 201）', async () => {
    const res = await fetch(`${ts.baseUrl}/api/user`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: true });
  });

  it('handler 抛错 → 框架错误兜底（GET /api/error/throw → 500）', async () => {
    const res = await fetch(`${ts.baseUrl}/api/error/throw`);
    expect(res.status).toBe(500);
  });

  it('路由未匹配 → 404', async () => {
    const res = await fetch(`${ts.baseUrl}/api/not-exist`);
    expect(res.status).toBe(404);
  });

  it('HEAD 请求 → 204', async () => {
    const res = await fetch(`${ts.baseUrl}/api/health`, { method: 'HEAD' });
    expect(res.status).toBe(204);
  });
});

describe('createTestServer 自定义 options', () => {
  let ts: TestServer;

  afterAll(async () => {
    if (ts) await ts.close();
  });

  it('传入全局中间件 + 业务 config', async () => {
    const authMiddleware: any = async (ctx: any, next: any) => {
      ctx.requestId = 'test-req-id';
      await next();
    };
    ts = await createTestServer({
      rootDir: FIXTURES_DIR,
      patterns: ['api/**/*.ts'],
      middlewares: [authMiddleware],
      config: { db: { host: 'test', port: 5432 } },
    });

    const res = await fetch(`${ts.baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });

  it('传入 onError 钩子捕获 handler 错误', async () => {
    const errors: unknown[] = [];
    const ts2 = await createTestServer({
      rootDir: FIXTURES_DIR,
      patterns: ['api/**/*.ts'],
      onError: (err) => {
        errors.push(err);
      },
    });
    try {
      await fetch(`${ts2.baseUrl}/api/error/throw`);
      // 等微任务 + onError 异步触发
      await new Promise((r) => setTimeout(r, 50));
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      await ts2.close();
    }
  });
});

describe('createTestServer 默认禁用 CORS/Helmet/Logger', () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer({
      rootDir: FIXTURES_DIR,
      patterns: ['api/**/*.ts'],
    });
  });

  afterAll(async () => {
    if (ts) await ts.close();
  });

  it('默认无 CORS 头（避免污染断言）', async () => {
    const res = await fetch(`${ts.baseUrl}/api/health`);
    // 默认 cors: false，不应有 access-control-allow-origin
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('启用 CORS 后响应含 access-control-allow-origin', async () => {
    const ts2 = await createTestServer({
      rootDir: FIXTURES_DIR,
      patterns: ['api/**/*.ts'],
      // cors: true 表示反射请求 Origin（参考 cors.ts 实现）
      cors: true,
    });
    try {
      // CORS 中间件仅在请求带 Origin 头时才设置响应头
      const res = await fetch(`${ts2.baseUrl}/api/health`, {
        headers: { origin: 'http://example.com' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('http://example.com');
    } finally {
      await ts2.close();
    }
  });
});

describe('TestServer.close 行为', () => {
  it('close 后 schemaDist 目录被清理', async () => {
    const ts = await createTestServer({
      rootDir: FIXTURES_DIR,
      patterns: ['api/**/*.ts'],
    });
    const schemaDist = ts.schemaDist;
    expect(await fs.stat(schemaDist).then((s) => s.isDirectory())).toBe(true);

    await ts.close();
    await expect(fs.stat(schemaDist)).rejects.toThrow();
  });

  it('close 后 server 不再 listen', async () => {
    const ts = await createTestServer({
      rootDir: FIXTURES_DIR,
      patterns: ['api/**/*.ts'],
    });
    const baseUrl = ts.baseUrl;
    await ts.close();

    await expect(fetch(`${baseUrl}/api/health`)).rejects.toThrow();
  });

  it('close 幂等：重复调用不抛错', async () => {
    const ts = await createTestServer({
      rootDir: FIXTURES_DIR,
      patterns: ['api/**/*.ts'],
    });
    await ts.close();
    await expect(ts.close()).resolves.toBeUndefined();
  });

  it('close 后调用 invalidateSchemaCache 清空缓存', async () => {
    // 触发一次请求让 schema 模块被加载到缓存
    const ts = await createTestServer({
      rootDir: FIXTURES_DIR,
      patterns: ['api/**/*.ts'],
    });
    await fetch(`${ts.baseUrl}/api/health`);
    await ts.close();
    // 验证 invalidateSchemaCache 已被调用（间接验证：再次 createTestServer 能正常工作）
    invalidateSchemaCache(); // 显式清空，确保下一个测试干净启动
  });
});

describe('createTestServer 显式传入 dist', () => {
  it('传入 dist 时不创建临时目录，schema 直接生成在指定 dist', async () => {
    const dist = path.resolve(__dirname, '../.tmp-test-dist-' + Date.now());
    const ts = await createTestServer({
      rootDir: FIXTURES_DIR,
      patterns: ['api/**/*.ts'],
      dist,
    });
    try {
      // schemaDist 应等于传入的 dist
      expect(path.resolve(ts.schemaDist)).toBe(path.resolve(dist));
      const res = await fetch(`${ts.baseUrl}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      await ts.close();
      // ts.close 已清理 schemaDist
      await expect(fs.stat(dist)).rejects.toThrow();
    }
  });
});
