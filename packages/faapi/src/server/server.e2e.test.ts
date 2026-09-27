import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { createServer } from './createServer';
import { generateSchemaFiles } from '../cli/generateSchemaFiles';
import { invalidateSchemaCache } from '../validator/validateInput';
import { configureLogging } from '../logger/logger';
import type { Server } from 'node:http';
import type { RouteManifest } from '../router/routeTypes';
import type { FaapiMiddleware } from '../middleware/middlewareTypes';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/api-basic');

let server: Server | null = null;
let baseUrl: string;
let schemaDist: string;

/** 生成 zod.js 到临时目录（createServer 运行时按 route.filePath + dist 计算 zod.js 路径） */
async function ensureSchemaLoaded(routes: RouteManifest, rootDir: string): Promise<void> {
  if (schemaDist) return;
  schemaDist = await fs.mkdtemp(path.join(os.tmpdir(), 'faapi-e2e-schema-'));
  await generateSchemaFiles(routes, rootDir, schemaDist);
}

async function setupServer(): Promise<{ server: Server; baseUrl: string }> {
  const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
  const sorted = sortRoutes(routes);
  await ensureSchemaLoaded(sorted, FIXTURES_DIR);
  const { server: srv } = createServer({
    routes: sorted,
    rootDir: FIXTURES_DIR,
    dist: schemaDist,
  });

  return new Promise((resolve, reject) => {
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr !== null) {
        const url = `http://localhost:${addr.port}`;
        resolve({ server: srv, baseUrl: url });
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
  });
}

async function fetchFromServer(path: string, init?: RequestInit): Promise<Response> {
  if (!server) {
    const result = await setupServer();
    server = result.server;
    baseUrl = result.baseUrl;
  }
  return fetch(`${baseUrl}${path}`, init);
}

/** 顶层 beforeAll：预生成 zod.js，确保所有 createServer 调用时 schemaDist 已就绪 */
beforeAll(async () => {
  const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
  const sorted = sortRoutes(routes);
  await ensureSchemaLoaded(sorted, FIXTURES_DIR);
});

/**
 * 使用自定义选项创建服务器（用于 CORS 等测试）
 */
async function setupServerWithOptions(
  options: Record<string, unknown> = {},
): Promise<{ server: Server; baseUrl: string }> {
  const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
  const sorted = sortRoutes(routes);
  await ensureSchemaLoaded(sorted, FIXTURES_DIR);
  const { server: srv } = createServer({
    routes: sorted,
    rootDir: FIXTURES_DIR,
    dist: schemaDist,
    ...options,
  });
  return new Promise((resolve, reject) => {
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr !== null) {
        resolve({ server: srv, baseUrl: `http://localhost:${addr.port}` });
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
  });
}

/**
 * 关闭服务器
 */
async function closeServer(srv: Server): Promise<void> {
  return new Promise((resolve) => {
    srv.close(() => resolve());
  });
}

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
    server = null;
  }
  if (schemaDist) {
    await fs.rm(schemaDist, { recursive: true, force: true });
  }
  invalidateSchemaCache();
});

describe('HTTP Server E2E', () => {
  it('GET /auth/login 返回 200', async () => {
    const res = await fetchFromServer('/api/auth/login');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { token: 'mock-jwt-token' } });
  });

  it('GET /user/123 返回 200（动态路由）', async () => {
    const res = await fetchFromServer('/api/user/123');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { id: '1' } });
  });

  it('路径参数按声明类型转换：number 段拿到数字，query 声明字段拿到转换值，未声明字段保留原始字符串', async () => {
    const res = await fetchFromServer('/api/order/42?verbose=true&limit=5&extra=abc');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      data: {
        orderId: 42,
        orderIdType: 'number',
        verbose: true,
        verboseType: 'boolean',
        limit: 5,
        extra: 'abc',
        // ctx.query / ctx.params 与 handler 注入是同一对象（转换后口径全链路一致）
        ctxQuerySame: true,
        ctxParamsSame: true,
      },
    });
  });

  it('路径参数类型不匹配（number 段传非数字）返回 422', async () => {
    const res = await fetchFromServer('/api/order/abc?verbose=true');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST 方法路径参数同样按声明类型转换，目录中间件可见 ctx.body 转换值', async () => {
    const res = await fetchFromServer('/api/order/7', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ orderId: 7, orderIdType: 'number', title: 'x', mwBodyTitle: 'x' });
  });

  it('params 声明为 string 时保持字符串（转换由声明类型驱动）', async () => {
    const res = await fetchFromServer('/api/legacy/zz');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ key: 'zz', keyType: 'string' });
  });

  it('catch-all 等声明之外的段不被 params schema 剥掉（原始值打底合并）', async () => {
    const res = await fetchFromServer('/api/docs/zh/a/b');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      lang: 'zh',
      langType: 'string',
      rest: 'a/b',
      restType: 'string',
    });
  });

  it('DELETE 主输入 query 按声明类型转换，目录中间件拿到回写后的 params', async () => {
    const res = await fetchFromServer('/api/order/9?verbose=true', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      orderId: 9,
      orderIdType: 'number',
      verbose: true,
      verboseType: 'boolean',
      mwOrderIdType: 'number',
      // DELETE 主输入是 query、未声明 body 形参：ctx.body 恒 undefined
      ctxBodyUndefined: true,
    });
  });

  it('GET /unknown 返回 404', async () => {
    const res = await fetchFromServer('/unknown');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('DELETE /auth/login 返回 405（路由存在但方法不存在）', async () => {
    const res = await fetchFromServer('/api/auth/login', { method: 'DELETE' });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
    // 检查 Allow 头
    const allow = res.headers.get('Allow');
    expect(allow).toContain('GET');
    expect(allow).toContain('POST');
  });

  it('DELETE 携带 JSON body：body 参数收到请求体而非 query，ctx.body 为同一对象', async () => {
    const res = await fetchFromServer('/api/item?id=99', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 7 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // body 注入的是请求体 { id: 7 }，不是 query { id: '99' }；ctx.body 为同一对象
    expect(body).toEqual({ data: { deleted: 7, at: null, ctxBodySame: true } });
  });

  it('DELETE 声明 body 且空请求体：与 POST 同路径返回 422（不再注入 undefined）', async () => {
    const res = await fetchFromServer('/api/item?id=1', { method: 'DELETE' });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('DELETE body 声明类型后走 schema 校验：非法 payload 返回 422', async () => {
    const res = await fetchFromServer('/api/item?id=9', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'not-a-number' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('DELETE body 的 Date 字段按 schema 转换（与 POST body 一致）', async () => {
    const res = await fetchFromServer('/api/item?id=9', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      // 传 ISO 字符串：schema 转换为 Date 后序列化回毫秒时间戳；
      // 若无 schema（裸透传）则原样返回字符串——用例借此区分两种行为
      body: JSON.stringify({ id: 7, at: '2025-06-15T15:06:40.000Z' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ deleted: 7, at: 1750000000000, ctxBodySame: true });
  });

  it('DELETE 声明 form 形参：form-urlencoded 请求体按 schema 校验转换（此前 400）', async () => {
    const res = await fetchFromServer('/api/item-form?id=99', {
      method: 'DELETE',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'id=7&force=true',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // form 值来源均为 string，DELETEBody schema coerce=true 转换 number/boolean
    expect(body.data).toEqual({
      deleted: 7,
      deletedType: 'number',
      force: true,
      forceType: 'boolean',
    });
  });

  it('DELETE form 值非法（id=abc）返回 422', async () => {
    const res = await fetchFromServer('/api/item-form?id=99', {
      method: 'DELETE',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'id=abc',
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST 声明 query 形参：主输入 body 之外，query 按声明类型校验转换', async () => {
    const res = await fetchFromServer('/api/search?page=2&extra=abc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keyword: 'x' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      page: 2,
      pageType: 'number',
      keyword: 'x',
      extra: 'abc',
    });
  });

  it('POST query 校验失败（page=abc）返回 422', async () => {
    const res = await fetchFromServer('/api/search?page=abc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keyword: 'x' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('ctx.query 为转换后对象且与注入同源，rawQuery 恒为原始 URLSearchParams', async () => {
    const res = await fetchFromServer('/api/raw?page=3');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      sameObject: true,
      page: 3,
      pageType: 'number',
      ctxPageType: 'number',
      rawPage: '3',
      rawPageType: 'string',
    });
  });

  it('rawParams 注入原始字符串，ctx.params 为转换值，ctx.rawParams 与注入同一对象', async () => {
    const res = await fetchFromServer('/api/raw/55');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      sameObject: true,
      id: 55,
      idType: 'number',
      rawId: '55',
      rawIdType: 'string',
      ctxRawParamsSame: true,
    });
  });

  it('rawBody 注入原始请求体文本（JSON 未解析字符串），ctx.body 为同一校验后对象', async () => {
    const res = await fetchFromServer('/api/raw/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hello' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      title: 'hello',
      ctxBodySame: true,
      rawBodyType: 'string',
      rawBodyIsRawJson: true,
    });
  });

  it('form 场景 rawBody 为原始 urlencoded 文本，form 字段按 schema 转换', async () => {
    const res = await fetchFromServer('/api/raw/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=form-title',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      title: 'form-title',
      titleType: 'string',
      rawBody: 'title=form-title',
    });
  });

  it('raw 路由 params 非法（非数字段）仍按声明校验返回 422', async () => {
    const res = await fetchFromServer('/api/raw/abc');
    expect(res.status).toBe(422);
  });

  it('handler 返回 object 时 Content-Type 为 application/json', async () => {
    const res = await fetchFromServer('/api/auth/login');
    expect(res.status).toBe(200);
    const contentType = res.headers.get('Content-Type');
    expect(contentType).toContain('application/json');
  });

  it('POST /auth/login 返回 200', async () => {
    const res = await fetchFromServer('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { ok: true } });
  });

  // ctx 功能 E2E 测试
  it('ctx.setStatus 设置自定义状态码', async () => {
    const res = await fetchFromServer('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ data: { created: true } });
  });

  it('ctx.setHeader 设置自定义响应头', async () => {
    const res = await fetchFromServer('/api/novel/list');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('max-age=3600');
    const body = await res.json();
    expect(body).toEqual({ data: { cached: true } });
  });

  it('ctx.redirect 返回 302 重定向', async () => {
    const res = await fetchFromServer('/api/redirect', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/auth/login');
  });

  it('HEAD 请求回退 GET handler：200 + 自定义头 + 无 body（探活场景）', async () => {
    const res = await fetchFromServer('/api/novel/list', { method: 'HEAD' });
    expect(res.status).toBe(200);
    // GET handler 的自定义头对 HEAD 生效
    expect(res.headers.get('Cache-Control')).toBe('max-age=3600');
    // HEAD 无响应 body
    const text = await res.text();
    expect(text).toBe('');
  });

  // 中间件 E2E 测试
  describe('middleware', () => {
    it('resolve 注入 db 参数', async () => {
      const res = await fetchFromServer('/api/admin/dashboard');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ data: { connected: true } });
    });

    it('resolve 鉴权：无 token 返回 401', async () => {
      const res = await fetchFromServer('/api/admin/profile');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    it('resolve 鉴权：有 token 注入 user', async () => {
      const res = await fetchFromServer('/api/admin/profile', {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ data: { name: 'alice', role: 'admin' } });
    });

    it('error 钩子捕获 handler 错误', async () => {
      const res = await fetchFromServer('/api/admin/broken');
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'something broke' } });
    });
  });

  // handler.ts E2E 测试
  describe('handler.ts', () => {
    it('GET /health 返回 200', async () => {
      const res = await fetchFromServer('/api/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ data: { status: 'ok' } });
    });

    it('HEAD /health 返回 204', async () => {
      const res = await fetchFromServer('/api/health', { method: 'HEAD' });
      expect(res.status).toBe(204);
    });
  });

  // CORS E2E 测试
  describe('CORS', () => {
    it('GET 带 Origin 头 → 响应包含 Access-Control-Allow-Origin', async () => {
      const res = await fetchFromServer('/api/auth/login', {
        headers: { Origin: 'http://example.com' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://example.com');
    });

    it('GET 不带 Origin 头 → 无 CORS 头', async () => {
      const res = await fetchFromServer('/api/auth/login');
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('OPTIONS 预检请求带 Origin → 返回 204 及 CORS 头', async () => {
      const res = await fetchFromServer('/api/auth/login', {
        method: 'OPTIONS',
        headers: { Origin: 'http://example.com' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://example.com');
      expect(res.headers.get('Access-Control-Allow-Methods')).toBeTruthy();
    });

    it('OPTIONS 预检请求不带 Origin → 无 CORS 头', async () => {
      const res = await fetchFromServer('/api/auth/login', {
        method: 'OPTIONS',
      });
      // 无 Origin 时 CORS 中间件不介入，走正常路由匹配，无 OPTIONS handler → 405
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    describe('cors: false', () => {
      let noCorsServer: Server;
      let noCorsBaseUrl: string;

      beforeAll(async () => {
        const result = await setupServerWithOptions({ cors: false });
        noCorsServer = result.server;
        noCorsBaseUrl = result.baseUrl;
      });

      afterAll(async () => {
        await closeServer(noCorsServer);
      });

      it('即使带 Origin 头也无 CORS 头', async () => {
        const res = await fetch(`${noCorsBaseUrl}/api/auth/login`, {
          headers: { Origin: 'http://example.com' },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
      });

      it('OPTIONS 预检请求无 CORS 头', async () => {
        const res = await fetch(`${noCorsBaseUrl}/api/auth/login`, {
          method: 'OPTIONS',
          headers: { Origin: 'http://example.com' },
        });
        // cors: false 时 CORS 中间件为 null，不处理预检
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
      });
    });
  });

  // Logger E2E 测试（egg 模型：请求日志无条件并入统一管道，config.log.accessLog: false 关闭）
  describe('logger', () => {
    describe('默认启用：请求日志经 console 出口输出（consoleLevel 默认 info）', () => {
      let defaultLoggerServer: Server;
      let defaultLoggerBaseUrl: string;

      beforeAll(async () => {
        const result = await setupServerWithOptions({});
        configureLogging({ consoleLevel: 'info' });
        defaultLoggerServer = result.server;
        defaultLoggerBaseUrl = result.baseUrl;
      });

      afterAll(async () => {
        await closeServer(defaultLoggerServer);
        configureLogging(undefined);
      });

      it('请求触发 console 输出 access 条目（文本格式含 method/path/status/duration）', async () => {
        const logSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
          const res = await fetch(`${defaultLoggerBaseUrl}/api/auth/login`);
          expect(res.status).toBe(200);
          expect(logSpy).toHaveBeenCalled();
          const line = logSpy.mock.calls[0][0] as string;
          expect(line).toMatch(/INFO \[access\] GET \/api\/auth\/login 200 \d+ms/);
        } finally {
          logSpy.mockRestore();
        }
      });

      it('错误请求也被记录（500 → error 级别，走 console.error）', async () => {
        const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const res = await fetch(`${defaultLoggerBaseUrl}/api/error/throw`);
          expect(res.status).toBe(500);
          expect(logSpy).toHaveBeenCalled();
          const line = logSpy.mock.calls[0][0] as string;
          expect(line).toMatch(/ERROR \[access\] GET \/api\/error\/throw 500 \d+ms/);
        } finally {
          logSpy.mockRestore();
        }
      });
    });

    describe('config.log.sink 接管：请求日志与业务日志同管道（scope access）', () => {
      let sinkServer: Server;
      let sinkBaseUrl: string;
      const entries: Array<{ level: string; scope?: string; message: string }> = [];

      beforeAll(async () => {
        const result = await setupServerWithOptions({});
        configureLogging({ sink: (e) => entries.push(e as never) });
        sinkServer = result.server;
        sinkBaseUrl = result.baseUrl;
      });

      afterAll(async () => {
        await closeServer(sinkServer);
        configureLogging(undefined);
      });

      it('请求条目进 sink（level 按 status 映射，fields 含 requestId/status）', async () => {
        const res = await fetch(`${sinkBaseUrl}/api/auth/login`);
        expect(res.status).toBe(200);
        const access = entries.filter((e) => e.scope === 'access');
        expect(access.length).toBeGreaterThanOrEqual(1);
        expect(access[0].level).toBe('info');
      });
    });

    describe('config.log.accessLog: false 关闭请求日志', () => {
      let noAccessServer: Server;
      let noAccessBaseUrl: string;

      beforeAll(async () => {
        const result = await setupServerWithOptions({});
        configureLogging({ accessLog: false });
        noAccessServer = result.server;
        noAccessBaseUrl = result.baseUrl;
      });

      afterAll(async () => {
        await closeServer(noAccessServer);
        configureLogging(undefined);
      });

      it('请求不产生任何日志输出', async () => {
        const spies = (['debug', 'info', 'warn', 'error'] as const).map((m) =>
          vi.spyOn(console, m).mockImplementation(() => {}),
        );
        try {
          const res = await fetch(`${noAccessBaseUrl}/api/auth/login`);
          expect(res.status).toBe(200);
          for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        } finally {
          for (const spy of spies) spy.mockRestore();
        }
      });
    });

    describe('config.log: false 全静默：请求日志一并关闭', () => {
      let silentServer: Server;
      let silentBaseUrl: string;

      beforeAll(async () => {
        const result = await setupServerWithOptions({});
        configureLogging(false);
        silentServer = result.server;
        silentBaseUrl = result.baseUrl;
      });

      afterAll(async () => {
        await closeServer(silentServer);
        configureLogging(undefined);
      });

      it('请求不产生任何日志输出', async () => {
        const spies = (['debug', 'info', 'warn', 'error'] as const).map((m) =>
          vi.spyOn(console, m).mockImplementation(() => {}),
        );
        try {
          const res = await fetch(`${silentBaseUrl}/api/auth/login`);
          expect(res.status).toBe(200);
          for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        } finally {
          for (const spy of spies) spy.mockRestore();
        }
      });
    });
  });

  // Cookie E2E 测试
  describe('Cookie', () => {
    it('请求带 Cookie 头 → handler 可通过 context 读取 cookies', async () => {
      const res = await fetchFromServer('/api/cookie/read', {
        headers: { Cookie: 'sessionId=sess123; theme=dark' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.cookies).toEqual({ sessionId: 'sess123', theme: 'dark' });
      expect(body.data.sessionId).toBe('sess123');
    });

    it('handler 设置 cookie → 响应包含 Set-Cookie 头', async () => {
      const res = await fetchFromServer('/api/cookie/set');
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).toContain('token=abc123');
      expect(setCookie).toContain('HttpOnly');
    });

    it('handler 删除 cookie → 响应包含 Set-Cookie 且 Max-Age=0', async () => {
      const res = await fetchFromServer('/api/cookie/delete');
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).toContain('token=');
      expect(setCookie).toContain('Max-Age=0');
    });
  });

  // 静态文件服务已移除（生产环境应使用 CDN/Nginx 等专用静态文件服务）

  // 错误处理 E2E 测试
  describe('Error handling', () => {
    it('无效 JSON body → 400 校验错误', async () => {
      const res = await fetchFromServer('/api/error/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('handler 抛出异常且无 error 中间件 → 500', async () => {
      const res = await fetchFromServer('/api/error/throw');
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('unhandled error');
    });
  });

  // handler 返回值直接序列化(无全局包装)E2E 测试
  describe('handler 返回值直接序列化为响应', () => {
    let rawServer: Server;
    let rawBaseUrl: string;

    beforeAll(async () => {
      const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
      const sorted = sortRoutes(routes);
      const { server: srv } = createServer({
        routes: sorted,
        rootDir: FIXTURES_DIR,
        dist: schemaDist,
      });

      await new Promise<void>((resolve, reject) => {
        srv.listen(0, () => {
          const addr = srv.address();
          if (typeof addr === 'object' && addr !== null) {
            rawServer = srv;
            rawBaseUrl = `http://localhost:${addr.port}`;
            resolve();
          } else {
            reject(new Error('Failed to get server address'));
          }
        });
      });
    });

    afterAll(async () => {
      await closeServer(rawServer);
    });

    it('handler 返回对象被框架自动包裹为 { data } 格式', async () => {
      const res = await fetch(`${rawBaseUrl}/api/auth/login`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ data: { token: 'mock-jwt-token' } });
    });

    it('Response 原样透传(redirect 等)', async () => {
      const res = await fetch(`${rawBaseUrl}/api/redirect`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/auth/login');
    });

    it('未知路由由内置 formatErrorResponse 兜底(404 + 标准 error 结构)', async () => {
      const res = await fetch(`${rawBaseUrl}/unknown-route`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('ROUTE_NOT_FOUND');
    });
  });

  // 全局中间件输入可见性 E2E：路由匹配已提前到中间件链之前
  describe('全局中间件输入可见性', () => {
    let gwServer: Server;
    let gwBaseUrl: string;
    const snapshots: Array<{
      beforeRawParamsId: string | undefined;
      beforeParams: unknown;
      beforeRawQueryGet: string | null;
      beforeQuery: unknown;
      afterParamsId: unknown;
    }> = [];

    beforeAll(async () => {
      const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
      const sorted = sortRoutes(routes);
      const gw: FaapiMiddleware = async (ctx, next) => {
        const beforeRawParamsId = ctx.rawParams?.['orderId'];
        const beforeParams = JSON.parse(JSON.stringify(ctx.params));
        const beforeRawQueryGet = ctx.rawQuery.get('verbose');
        const beforeQuery = JSON.parse(JSON.stringify(ctx.query));
        const res = await next();
        snapshots.push({
          beforeRawParamsId,
          beforeParams,
          beforeRawQueryGet,
          beforeQuery,
          afterParamsId: ctx.params['orderId'] ?? null,
        });
        return res;
      };
      const { server: srv } = createServer({
        routes: sorted,
        rootDir: FIXTURES_DIR,
        dist: schemaDist,
        middlewares: [gw],
      });
      await new Promise<void>((resolve, reject) => {
        srv.listen(0, () => {
          const addr = srv.address();
          if (typeof addr === 'object' && addr !== null) {
            gwServer = srv;
            gwBaseUrl = `http://localhost:${addr.port}`;
            resolve();
          } else {
            reject(new Error('Failed to get server address'));
          }
        });
      });
    });

    afterAll(async () => {
      await closeServer(gwServer);
    });

    it('next() 前：ctx.rawParams 可用（原始段），ctx.query 为原始对象；next() 后 ctx.params 为转换值', async () => {
      const res = await fetch(`${gwBaseUrl}/api/order/42?verbose=true`, {
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);
      expect(snapshots.length).toBeGreaterThanOrEqual(1);
      const snap = snapshots[snapshots.length - 1]!;
      // next() 前：路由已匹配，rawParams 为原始段
      expect(snap.beforeRawParamsId).toBe('42');
      // next() 前：params 尚未校验回写，为原始字符串段
      expect(snap.beforeParams).toEqual({ orderId: '42' });
      // next() 前：rawQuery 恒原始，query 为原始字符串对象
      expect(snap.beforeRawQueryGet).toBe('true');
      expect(snap.beforeQuery).toEqual({ verbose: 'true' });
      // next() 后：管线已按声明类型校验并回写 ctx.params
      expect(snap.afterParamsId).toBe(42);
    });

    it('404 请求仍经过全局中间件（匹配提前不改变响应路径）', async () => {
      const res = await fetch(`${gwBaseUrl}/unknown-gw`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('ROUTE_NOT_FOUND');
    });
  });

  // onError 生命周期钩子 E2E 测试
  describe('onError hook', () => {
    let onErrorServer: Server;
    let onErrorBaseUrl: string;
    let capturedError: unknown;
    let capturedPath: string;

    beforeAll(async () => {
      const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
      const sorted = sortRoutes(routes);
      const { server: srv } = createServer({
        routes: sorted,
        rootDir: FIXTURES_DIR,
        dist: schemaDist,
        onError: (error, ctx) => {
          capturedError = error;
          capturedPath = ctx.path;
        },
      });
      await new Promise<void>((resolve, reject) => {
        srv.listen(0, () => {
          const addr = srv.address();
          if (typeof addr === 'object' && addr !== null) {
            onErrorServer = srv;
            onErrorBaseUrl = `http://localhost:${addr.port}`;
            resolve();
          } else {
            reject(new Error('Failed to get server address'));
          }
        });
      });
    });

    afterAll(async () => {
      await closeServer(onErrorServer);
    });

    it('请求出错时 onError 被调用,接收 error 和 ctx', async () => {
      capturedError = undefined;
      const res = await fetch(`${onErrorBaseUrl}/nonexistent-route`);
      expect(res.status).toBe(404);
      expect(capturedError).toBeInstanceOf(Error);
      expect(capturedPath).toBe('/nonexistent-route');
    });

    it('onError 不影响响应格式(响应仍由内置 formatErrorResponse 决定)', async () => {
      const res = await fetch(`${onErrorBaseUrl}/nonexistent-route`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('ROUTE_NOT_FOUND');
    });

    it('全局中间件 try/catch 自定义错误响应', async () => {
      const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
      const sorted = sortRoutes(routes);
      const errorHandler: FaapiMiddleware = async (ctx, next) => {
        try {
          await next();
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          return ctx.json({ error: { code: 'INTERNAL_ERROR', message } }, 500);
        }
      };
      const { server: srv } = createServer({
        routes: sorted,
        rootDir: FIXTURES_DIR,
        dist: schemaDist,
        middlewares: [errorHandler],
      });
      const { server: customSrv, baseUrl: customUrl } = await new Promise<{
        server: Server;
        baseUrl: string;
      }>((resolve, reject) => {
        srv.listen(0, () => {
          const addr = srv.address();
          if (typeof addr === 'object' && addr !== null) {
            resolve({ server: srv, baseUrl: `http://localhost:${addr.port}` });
          } else {
            reject(new Error('Failed to get server address'));
          }
        });
      });
      try {
        const res = await fetch(`${customUrl}/nonexistent-route`);
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error.code).toBe('INTERNAL_ERROR');
        expect(body.error.message).toBeTruthy();
      } finally {
        await closeServer(customSrv);
      }
    });
  });

  // SSE 流式响应 E2E 测试
  describe('SSE (Server-Sent Events)', () => {
    it('handler 通过 ctx.sse() 返回 text/event-stream 响应', async () => {
      const res = await fetchFromServer('/api/sse');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
      expect(res.headers.get('Connection')).toBe('keep-alive');
      const body = await res.text();
      expect(body).toBe('data: first\n\nevent: progress\ndata: 50\n\nevent: done\ndata: 100\n\n');
    });
  });

  // 请求体大小限制
  describe('bodyLimit', () => {
    it('content-length 超限时直接返回 413（免流式读取）', async () => {
      const { server: smallSrv } = createServer({
        routes: [],
        rootDir: FIXTURES_DIR,
        dist: schemaDist ?? '.faapi',
        bodyLimit: 10, // 10 字节
      });
      const addr = await new Promise<import('node:net').AddressInfo>((resolve, reject) => {
        smallSrv.listen(0, () => {
          const a = smallSrv.address();
          if (typeof a === 'object' && a !== null) resolve(a);
          else reject(new Error('no address'));
        });
      });

      try {
        // Node fetch 自动带 content-length: 100
        const res = await fetch(`http://localhost:${addr.port}/api/anything`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'x'.repeat(100),
        });
        expect(res.status).toBe(413);
        const body = await res.json();
        expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
        // 请求体未消费,keep-alive 连接不可复用——必须声明 close,
        // 客户端重发大 body 时拿到的是明确 413 而非连接层面的晦涩错误
        expect(res.headers.get('connection')).toBe('close');
      } finally {
        await closeServer(smallSrv);
      }
    });
  });

  describe('compression + etag（config 选项，完整链路）', () => {
    it('compression: true 时 gzip 响应 + Vary: Accept-Encoding', async () => {
      const { server: srv, baseUrl } = await setupServerWithOptions({
        // fixture 响应体很小（~22B），调低阈值验证压缩路径
        compression: { threshold: 10 },
        cors: false,
        logger: false,
      });
      try {
        const res = await fetch(`${baseUrl}/api/novel/list`, {
          headers: { 'Accept-Encoding': 'gzip' },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-encoding')).toBe('gzip');
        expect(res.headers.get('vary')).toContain('Accept-Encoding');
        const body = await res.json();
        expect(body).toEqual({ data: { cached: true } });
      } finally {
        await closeServer(srv);
      }
    });

    it('etag: true 时 200 带 ETag，If-None-Match 命中返回 304', async () => {
      const { server: srv, baseUrl } = await setupServerWithOptions({
        etag: true,
        cors: false,
        logger: false,
      });
      try {
        const first = await fetch(`${baseUrl}/api/novel/list`);
        expect(first.status).toBe(200);
        const etagValue = first.headers.get('etag');
        expect(etagValue).toMatch(/^W\//);
        expect(first.headers.get('vary')).toBeNull();

        // 第二次请求带 If-None-Match → 304
        const second = await fetch(`${baseUrl}/api/novel/list`, {
          headers: { 'If-None-Match': etagValue! },
        });
        expect(second.status).toBe(304);
        expect(await second.text()).toBe('');
        expect(second.headers.get('etag')).toBe(etagValue);
      } finally {
        await closeServer(srv);
      }
    });

    it('compression + etag 同时启用：ETag 基于未压缩表示，304 协商正确', async () => {
      const { server: srv, baseUrl } = await setupServerWithOptions({
        compression: { threshold: 10 },
        etag: true,
        cors: false,
        logger: false,
      });
      try {
        // 客户端接受 gzip：拿到压缩响应，ETag 为未压缩表示的弱指纹
        const first = await fetch(`${baseUrl}/api/novel/list`, {
          headers: { 'Accept-Encoding': 'gzip' },
        });
        expect(first.headers.get('content-encoding')).toBe('gzip');
        const etagValue = first.headers.get('etag')!;

        // 协商 304（不带 Accept-Encoding 也可——弱校验允许表示差异）
        const second = await fetch(`${baseUrl}/api/novel/list`, {
          headers: { 'If-None-Match': etagValue },
        });
        expect(second.status).toBe(304);
        expect(second.headers.get('etag')).toBe(etagValue);
      } finally {
        await closeServer(srv);
      }
    });
  });
});
