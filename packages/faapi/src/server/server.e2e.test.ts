import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { createServer } from './createServer';
import { generateSchemaFiles } from '../cli/generateSchemaFiles';
import { invalidateSchemaCache } from '../validator/validateInput';
import { ValidationError } from '../errors/httpErrors';
import type { Server } from 'node:http';
import type { RouteManifest } from '../router/routeTypes';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/api-basic');

let server: Server | null = null;
let baseUrl: string;
let schemaOutDir: string;

/** 生成 zod.js 到临时目录（createServer 运行时按 route.filePath + outDir 计算 zod.js 路径） */
async function ensureSchemaLoaded(routes: RouteManifest, rootDir: string): Promise<void> {
  if (schemaOutDir) return;
  schemaOutDir = await fs.mkdtemp(path.join(os.tmpdir(), 'faapi-e2e-schema-'));
  await generateSchemaFiles(routes, rootDir, '.', schemaOutDir);
}

async function setupServer(): Promise<{ server: Server; baseUrl: string }> {
  const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
  const sorted = sortRoutes(routes);
  await ensureSchemaLoaded(sorted, FIXTURES_DIR);
  const { server: srv } = createServer({
    routes: sorted,
    rootDir: FIXTURES_DIR,
    appDir: '.',
    outDir: schemaOutDir,
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

/** 顶层 beforeAll：预生成 zod.js，确保所有 createServer 调用时 schemaOutDir 已就绪 */
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
    appDir: '.',
    outDir: schemaOutDir,
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
  if (schemaOutDir) {
    await fs.rm(schemaOutDir, { recursive: true, force: true });
  }
  invalidateSchemaCache();
});

describe('HTTP Server E2E', () => {
  it('GET /auth/login 返回 200', async () => {
    const res = await fetchFromServer('/api/auth/login');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ token: 'mock-jwt-token' });
  });

  it('GET /user/123 返回 200（动态路由）', async () => {
    const res = await fetchFromServer('/api/user/123');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: '1' });
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
    expect(body).toEqual({ ok: true });
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
    expect(body).toEqual({ created: true });
  });

  it('ctx.setHeader 设置自定义响应头', async () => {
    const res = await fetchFromServer('/api/novel/list');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('max-age=3600');
    const body = await res.json();
    expect(body).toEqual({ cached: true });
  });

  it('ctx.redirect 返回 302 重定向', async () => {
    const res = await fetchFromServer('/api/redirect', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/auth/login');
  });

  // 中间件 E2E 测试
  describe('middleware', () => {
    it('resolve 注入 db 参数', async () => {
      const res = await fetchFromServer('/api/admin/dashboard');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ connected: true });
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
      expect(body).toEqual({ name: 'alice', role: 'admin' });
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
      expect(body).toEqual({ status: 'ok' });
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

  // Cookie E2E 测试
  describe('Cookie', () => {
    it('请求带 Cookie 头 → handler 可通过 context 读取 cookies', async () => {
      const res = await fetchFromServer('/api/cookie/read', {
        headers: { Cookie: 'sessionId=sess123; theme=dark' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cookies).toEqual({ sessionId: 'sess123', theme: 'dark' });
      expect(body.sessionId).toBe('sess123');
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

  // responseFormat 和 errorFormat E2E 测试
  describe('responseFormat and errorFormat', () => {
    let fmtServer: Server;
    let fmtBaseUrl: string;

    beforeAll(async () => {
      const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
      const sorted = sortRoutes(routes);
      const { server: srv } = createServer({
        routes: sorted,
        rootDir: FIXTURES_DIR,
        appDir: '.',
        outDir: schemaOutDir,
        responseFormat: (data) => ({ code: 0, data, message: 'success' }),
        errorFormat: (err) =>
          new Response(
            JSON.stringify({
              code: 500,
              message: err instanceof Error ? err.message : 'Unknown error',
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      await new Promise<void>((resolve, reject) => {
        srv.listen(0, () => {
          const addr = srv.address();
          if (typeof addr === 'object' && addr !== null) {
            fmtServer = srv;
            fmtBaseUrl = `http://localhost:${addr.port}`;
            resolve();
          } else {
            reject(new Error('Failed to get server address'));
          }
        });
      });
    });

    afterAll(async () => {
      await closeServer(fmtServer);
    });

    it('responseFormat 包装成功响应', async () => {
      const res = await fetch(`${fmtBaseUrl}/api/auth/login`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ code: 0, data: { token: 'mock-jwt-token' }, message: 'success' });
    });

    it('responseFormat 不影响 Response 原样透传', async () => {
      const res = await fetch(`${fmtBaseUrl}/api/redirect`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/auth/login');
    });

    it('errorFormat 自定义错误响应', async () => {
      const res = await fetch(`${fmtBaseUrl}/unknown-route`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe(500);
      expect(body.message).toBeTruthy();
    });

    it('无 responseFormat 时保持原始响应', async () => {
      // 创建不带 responseFormat 的服务器
      const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
      const sorted = sortRoutes(routes);
      const { server: noFmtSrv } = createServer({
        routes: sorted,
        rootDir: FIXTURES_DIR,
        appDir: '.',
        outDir: schemaOutDir,
      });
      const { server: rawSrv, baseUrl: rawUrl } = await new Promise<{
        server: Server;
        baseUrl: string;
      }>((resolve, reject) => {
        noFmtSrv.listen(0, () => {
          const addr = noFmtSrv.address();
          if (typeof addr === 'object' && addr !== null) {
            resolve({ server: noFmtSrv, baseUrl: `http://localhost:${addr.port}` });
          } else {
            reject(new Error('Failed to get server address'));
          }
        });
      });

      try {
        const res = await fetch(`${rawUrl}/api/auth/login`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ token: 'mock-jwt-token' });
      } finally {
        await closeServer(rawSrv);
      }
    });

    it('无 errorFormat 时使用默认错误格式', async () => {
      // 创建不带 errorFormat 的服务器
      const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
      const sorted = sortRoutes(routes);
      const { server: defaultErrSrv } = createServer({
        routes: sorted,
        rootDir: FIXTURES_DIR,
        appDir: '.',
        outDir: schemaOutDir,
      });
      const { server: rawSrv, baseUrl: rawUrl } = await new Promise<{
        server: Server;
        baseUrl: string;
      }>((resolve, reject) => {
        defaultErrSrv.listen(0, () => {
          const addr = defaultErrSrv.address();
          if (typeof addr === 'object' && addr !== null) {
            resolve({ server: defaultErrSrv, baseUrl: `http://localhost:${addr.port}` });
          } else {
            reject(new Error('Failed to get server address'));
          }
        });
      });

      try {
        const res = await fetch(`${rawUrl}/unknown-route`);
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error.code).toBe('ROUTE_NOT_FOUND');
      } finally {
        await closeServer(rawSrv);
      }
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
        appDir: '.',
        outDir: schemaOutDir,
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

    it('请求出错时 onError 被调用，接收 error 和 ctx', async () => {
      capturedError = undefined;
      const res = await fetch(`${onErrorBaseUrl}/nonexistent-route`);
      expect(res.status).toBe(404);
      expect(capturedError).toBeInstanceOf(Error);
      expect(capturedPath).toBe('/nonexistent-route');
    });

    it('onError 不影响响应格式（响应仍由默认 errorFormat 决定）', async () => {
      const res = await fetch(`${onErrorBaseUrl}/nonexistent-route`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('ROUTE_NOT_FOUND');
    });

    it('onError 在 errorFormat 之后执行（响应已生成后才触发副作用）', async () => {
      // 通过 errorFormat 与 onError 共同记录调用顺序，验证 onError 晚于 errorFormat
      const callOrder: string[] = [];
      const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
      const sorted = sortRoutes(routes);
      const { server: srv } = createServer({
        routes: sorted,
        rootDir: FIXTURES_DIR,
        appDir: '.',
        outDir: schemaOutDir,
        errorFormat: (_err) => {
          callOrder.push('errorFormat');
          return new Response(JSON.stringify({ ok: false }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        },
        onError: () => {
          callOrder.push('onError');
        },
      });
      const { server: orderSrv, baseUrl: orderUrl } = await new Promise<{
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
        const res = await fetch(`${orderUrl}/nonexistent-route`);
        expect(res.status).toBe(500);
        // 等待异步副作用落地
        await new Promise((r) => setTimeout(r, 20));
        expect(callOrder).toEqual(['errorFormat', 'onError']);
      } finally {
        await closeServer(orderSrv);
      }
    });

    it('errorFormat 自身抛错时由内置 formatErrorResponse 兜底', async () => {
      const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
      const sorted = sortRoutes(routes);
      const { server: srv } = createServer({
        routes: sorted,
        rootDir: FIXTURES_DIR,
        appDir: '.',
        outDir: schemaOutDir,
        errorFormat: () => {
          throw new Error('errorFormat boom');
        },
      });
      const { server: boomSrv, baseUrl: boomUrl } = await new Promise<{
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
        // /nonexistent-route 触发 RouteNotFoundError
        const res = await fetch(`${boomUrl}/nonexistent-route`);
        // errorFormat 抛错 → 内置 formatErrorResponse 兜底 → RouteNotFoundError 的 404 + 标准 error 结构
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error.code).toBe('ROUTE_NOT_FOUND');
      } finally {
        await closeServer(boomSrv);
      }
    });

    it('errorFormat 返回 null 时由内置 formatErrorResponse 处理', async () => {
      const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
      const sorted = sortRoutes(routes);
      const { server: srv } = createServer({
        routes: sorted,
        rootDir: FIXTURES_DIR,
        appDir: '.',
        outDir: schemaOutDir,
        // 仅处理 ValidationError，其余错误返回 null 交给框架兜底
        errorFormat: (err) => {
          if (err instanceof ValidationError) {
            return new Response(JSON.stringify({ custom: true, message: err.message }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return null;
        },
      });
      const { server: nullSrv, baseUrl: nullUrl } = await new Promise<{
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
        // /nonexistent-route 触发 RouteNotFoundError，errorFormat 返回 null
        // → 内置 formatErrorResponse 兜底 → 404 + 标准 error 结构
        const res = await fetch(`${nullUrl}/nonexistent-route`);
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error.code).toBe('ROUTE_NOT_FOUND');
      } finally {
        await closeServer(nullSrv);
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

    it('responseFormat 不包装 SSE 响应（保持原始事件流）', async () => {
      // 用带 responseFormat 的服务器测试 SSE 不被包装
      const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
      const sorted = sortRoutes(routes);
      const { server: srv } = createServer({
        routes: sorted,
        rootDir: FIXTURES_DIR,
        appDir: '.',
        outDir: schemaOutDir,
        responseFormat: (data) => ({ code: 0, data, message: 'success' }),
      });
      const { server: sseSrv, baseUrl: sseUrl } = await new Promise<{
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
        const res = await fetch(`${sseUrl}/api/sse`);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('text/event-stream');
        const body = await res.text();
        // 不应被 responseFormat 包装成 { code: 0, data: ... }
        expect(body).toBe('data: first\n\nevent: progress\ndata: 50\n\nevent: done\ndata: 100\n\n');
        expect(body).not.toContain('"code":0');
      } finally {
        await closeServer(sseSrv);
      }
    });
  });
});
