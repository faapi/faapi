import { describe, it, expect } from 'vitest';
import { cors } from './cors';
import type { FaapiContext } from '../runtime/contextTypes';
import type { ResponseMeta } from '../runtime/contextTypes';

function createMockContext(
  method = 'GET',
  origin?: string,
  extraHeaders?: Record<string, string>,
): FaapiContext & { meta: ResponseMeta } {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      headers.set(key, value);
    }
  }

  const meta: ResponseMeta = { headers: {}, setCookies: [] };
  const request = new Request('http://localhost/test', { method, headers });

  const cookies: Record<string, string> = {};

  return {
    request,
    params: {},
    query: new URLSearchParams(),
    headers,
    method,
    path: '/test',
    ip: '',
    cookies,
    config: {} as Record<string, unknown>,
    meta,

    setStatus(status: number) {
      meta.status = status;
    },

    setHeader(key: string, value: string) {
      meta.headers[key] = value;
    },

    setETag(value: string) {
      meta.headers['etag'] = value;
    },

    json(data: unknown, status?: number): Response {
      return new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },

    html(html: string, status?: number): Response {
      return new Response(html, {
        status: status ?? 200,
        headers: { 'Content-Type': 'text/html' },
      });
    },

    redirect(url: string, status = 302): Response {
      return new Response(null, { status, headers: { Location: url } });
    },

    sse(): never {
      throw new Error('sse() not supported in cors test mock');
    },

    getCookie(name: string): string | undefined {
      return cookies[name];
    },

    setCookie(name: string, value: string): void {
      cookies[name] = value;
    },

    deleteCookie(name: string): void {
      delete cookies[name];
    },
  };
}

// 调用 cors 中间件：传入一个返回空 Response 的 next（cors 不使用 next 返回值，返回 void）
async function callCors(
  middleware: ReturnType<typeof cors>,
  ctx: FaapiContext,
): Promise<Response | void> {
  return await middleware(ctx, async () => new Response(null));
}

describe('cors middleware', () => {
  describe('default (allow all)', () => {
    it('reflects request origin', async () => {
      const middleware = cors();
      const ctx = createMockContext('GET', 'http://example.com');
      const result = await callCors(middleware, ctx);

      expect(result).toBeUndefined();
      expect(ctx.meta.headers['Access-Control-Allow-Origin']).toBe('http://example.com');
      expect(ctx.meta.headers['Access-Control-Allow-Methods']).toBe(
        'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
      );
    });

    it('skips when no origin header', async () => {
      const middleware = cors();
      const ctx = createMockContext('GET');
      const result = await callCors(middleware, ctx);

      expect(result).toBeUndefined();
      expect(ctx.meta.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });
  });

  describe('specific origin', () => {
    it('allows specified origin string', async () => {
      const middleware = cors({ origin: 'http://allowed.com' });
      const ctx = createMockContext('GET', 'http://allowed.com');
      const result = await callCors(middleware, ctx);

      expect(result).toBeUndefined();
      expect(ctx.meta.headers['Access-Control-Allow-Origin']).toBe('http://allowed.com');
    });

    it('blocks non-matching origin', async () => {
      const middleware = cors({ origin: 'http://allowed.com' });
      const ctx = createMockContext('GET', 'http://evil.com');
      const result = await callCors(middleware, ctx);

      expect(result).toBeUndefined();
      expect(ctx.meta.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });
  });

  describe('multiple origins', () => {
    it('allows matching origin from array', async () => {
      const middleware = cors({ origin: ['http://a.com', 'http://b.com'] });
      const ctx = createMockContext('GET', 'http://b.com');
      const result = await callCors(middleware, ctx);

      expect(result).toBeUndefined();
      expect(ctx.meta.headers['Access-Control-Allow-Origin']).toBe('http://b.com');
    });

    it('blocks non-matching origin from array', async () => {
      const middleware = cors({ origin: ['http://a.com', 'http://b.com'] });
      const ctx = createMockContext('GET', 'http://c.com');
      const result = await callCors(middleware, ctx);

      expect(result).toBeUndefined();
      expect(ctx.meta.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });
  });

  describe('preflight OPTIONS', () => {
    it('returns 204 for OPTIONS preflight', async () => {
      const middleware = cors();
      const ctx = createMockContext('OPTIONS', 'http://example.com');
      const result = await callCors(middleware, ctx);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(204);
      expect(ctx.meta.headers['Access-Control-Allow-Origin']).toBe('http://example.com');
      expect(ctx.meta.headers['Access-Control-Allow-Methods']).toBe(
        'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
      );
    });

    it('skips OPTIONS without origin', async () => {
      const middleware = cors();
      const ctx = createMockContext('OPTIONS');
      const result = await callCors(middleware, ctx);

      expect(result).toBeUndefined();
      expect(ctx.meta.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });
  });

  describe('credentials', () => {
    it('sets Access-Control-Allow-Credentials when enabled', async () => {
      const middleware = cors({ credentials: true });
      const ctx = createMockContext('GET', 'http://example.com');
      await callCors(middleware, ctx);

      expect(ctx.meta.headers['Access-Control-Allow-Credentials']).toBe('true');
    });

    it('does not set credentials by default', async () => {
      const middleware = cors();
      const ctx = createMockContext('GET', 'http://example.com');
      await callCors(middleware, ctx);

      expect(ctx.meta.headers['Access-Control-Allow-Credentials']).toBeUndefined();
    });
  });

  describe('custom methods', () => {
    it('uses custom methods', async () => {
      const middleware = cors({ methods: ['GET', 'POST'] });
      const ctx = createMockContext('GET', 'http://example.com');
      await callCors(middleware, ctx);

      expect(ctx.meta.headers['Access-Control-Allow-Methods']).toBe('GET, POST');
    });
  });

  describe('custom headers', () => {
    it('sets specified allowedHeaders', async () => {
      const middleware = cors({ allowedHeaders: ['Content-Type', 'Authorization'] });
      const ctx = createMockContext('GET', 'http://example.com');
      await callCors(middleware, ctx);

      expect(ctx.meta.headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
    });

    it('reflects access-control-request-headers when allowedHeaders not set', async () => {
      const middleware = cors();
      const ctx = createMockContext('OPTIONS', 'http://example.com', {
        'access-control-request-headers': 'X-Custom-Header',
      });
      await callCors(middleware, ctx);

      expect(ctx.meta.headers['Access-Control-Allow-Headers']).toBe('X-Custom-Header');
    });
  });

  describe('exposeHeaders', () => {
    it('sets Access-Control-Expose-Headers', async () => {
      const middleware = cors({ exposeHeaders: ['X-Total-Count'] });
      const ctx = createMockContext('GET', 'http://example.com');
      await callCors(middleware, ctx);

      expect(ctx.meta.headers['Access-Control-Expose-Headers']).toBe('X-Total-Count');
    });

    it('does not set exposeHeaders when empty', async () => {
      const middleware = cors({ exposeHeaders: [] });
      const ctx = createMockContext('GET', 'http://example.com');
      await callCors(middleware, ctx);

      expect(ctx.meta.headers['Access-Control-Expose-Headers']).toBeUndefined();
    });
  });

  describe('maxAge', () => {
    it('sets Access-Control-Max-Age', async () => {
      const middleware = cors({ maxAge: 3600 });
      const ctx = createMockContext('GET', 'http://example.com');
      await callCors(middleware, ctx);

      expect(ctx.meta.headers['Access-Control-Max-Age']).toBe('3600');
    });

    it('does not set maxAge by default', async () => {
      const middleware = cors();
      const ctx = createMockContext('GET', 'http://example.com');
      await callCors(middleware, ctx);

      expect(ctx.meta.headers['Access-Control-Max-Age']).toBeUndefined();
    });
  });
});
