import { describe, it, expect } from 'vitest';
import { createContext } from './createContext';

describe('createContext', () => {
  it('从 Request 创建 context，path 正确', () => {
    const request = new Request('http://localhost/api/users');
    const ctx = createContext(request, {});
    expect(ctx.path).toBe('/api/users');
  });

  it('未传 ip 时 ctx.ip 默认为空字符串', () => {
    const ctx = createContext(new Request('http://localhost/'), {});
    expect(ctx.ip).toBe('');
  });

  it('传入 ip 时 ctx.ip 正确存储', () => {
    const ctx = createContext(new Request('http://localhost/'), {}, {}, '203.0.113.1');
    expect(ctx.ip).toBe('203.0.113.1');
  });

  it('query 参数正确提取', () => {
    const request = new Request('http://localhost/api/users?name=alice&age=30');
    const ctx = createContext(request, {});
    expect(ctx.query.get('name')).toBe('alice');
    expect(ctx.query.get('age')).toBe('30');
  });

  it('params 正确传入', () => {
    const request = new Request('http://localhost/api/users/123');
    const ctx = createContext(request, { id: '123' });
    expect(ctx.params).toEqual({ id: '123' });
  });

  it('headers 可访问', () => {
    const request = new Request('http://localhost/api/users', {
      headers: { 'Content-Type': 'application/json', 'X-Custom': 'test' },
    });
    const ctx = createContext(request, {});
    expect(ctx.headers.get('content-type')).toBe('application/json');
    expect(ctx.headers.get('x-custom')).toBe('test');
  });

  it('setStatus 设置状态码', () => {
    const request = new Request('http://localhost/api/test');
    const ctx = createContext(request, {});
    ctx.setStatus(201);
    expect((ctx as any).meta.status).toBe(201);
  });

  it('setHeader 设置响应头', () => {
    const request = new Request('http://localhost/api/test');
    const ctx = createContext(request, {});
    ctx.setHeader('Cache-Control', 'max-age=3600');
    expect((ctx as any).meta.headers['Cache-Control']).toBe('max-age=3600');
  });

  it('redirect 返回 302 Response', () => {
    const request = new Request('http://localhost/api/test');
    const ctx = createContext(request, {});
    const res = ctx.redirect('/login');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
  });

  it('redirect 支持自定义状态码', () => {
    const request = new Request('http://localhost/api/test');
    const ctx = createContext(request, {});
    const res = ctx.redirect('/login', 301);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/login');
  });

  it('json 返回 JSON Response', async () => {
    const request = new Request('http://localhost/api/test');
    const ctx = createContext(request, {});
    const res = ctx.json({ name: 'test' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.json()).toEqual({ name: 'test' });
  });

  it('json 支持自定义状态码', () => {
    const request = new Request('http://localhost/api/test');
    const ctx = createContext(request, {});
    const res = ctx.json({ error: 'Not found' }, 404);
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('html 返回 HTML Response', async () => {
    const request = new Request('http://localhost/api/test');
    const ctx = createContext(request, {});
    const res = ctx.html('<h1>Hello</h1>');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('<h1>Hello</h1>');
  });

  it('html 支持自定义状态码', () => {
    const request = new Request('http://localhost/api/test');
    const ctx = createContext(request, {});
    const res = ctx.html('<h1>Error</h1>', 500);
    expect(res.status).toBe(500);
  });

  describe('sse', () => {
    it('ctx.sse 返回 writer，有 send/close 方法', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      const sse = ctx.sse();
      expect(typeof sse.send).toBe('function');
      expect(typeof sse.close).toBe('function');
    });

    it('ctx.sse 在 ctx 上缓存 SSE Response（内部字段 __sseResponse）', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      const sse = ctx.sse();
      const sseResponse = (ctx as any).__sseResponse;
      expect(sseResponse).toBe(sse.response);
      expect(sseResponse.headers.get('Content-Type')).toBe('text/event-stream');
    });

    it('ctx.sse 创建的 Response 默认 200', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      const sse = ctx.sse();
      expect(sse.response.status).toBe(200);
    });

    it('ctx.setStatus 影响 SSE Response 的状态码（通过 meta 合并）', async () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setStatus(201);
      const sse = ctx.sse();
      // invokeHandler 会用 mergeMeta 把 meta.status 合并到 SSE Response
      // 这里只验证 meta 已设置
      expect((ctx as any).meta.status).toBe(201);
      expect(sse.response.status).toBe(200); // 原始 response 仍是 200
    });

    it('ctx.setHeader 设置的 header 会合并到 SSE Response（通过 meta 合并）', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setHeader('X-Custom', 'test');
      const sse = ctx.sse();
      // SSE Response 本身不含 X-Custom，mergeMeta 时才合并
      expect(sse.response.headers.get('X-Custom')).toBeNull();
      expect((ctx as any).meta.headers['X-Custom']).toBe('test');
    });
  });

  describe('extendContext', () => {
    it('config.extendContext 被调用，可挂载自定义方法到 ctx', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(
        request,
        {},
        {
          extendContext(c: any) {
            c.xml = (data: string) =>
              new Response(data, { headers: { 'Content-Type': 'application/xml' } });
          },
        },
      );
      expect(typeof (ctx as any).xml).toBe('function');
      const res = (ctx as any).xml('<root/>');
      expect(res.headers.get('Content-Type')).toBe('application/xml');
    });

    it('未配置 extendContext 时正常创建 ctx', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      expect(ctx.path).toBe('/api/test');
    });

    it('extendContext 可访问 ctx 的内置字段', () => {
      const request = new Request('http://localhost/api/test');
      let capturedPath = '';
      createContext(
        request,
        {},
        {
          extendContext(c: any) {
            capturedPath = c.path;
          },
        },
      );
      expect(capturedPath).toBe('/api/test');
    });
  });

  describe('setETag', () => {
    it('ctx.setETag 设置 ETag 到 meta.headers', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setETag('"abc123"');
      expect((ctx as any).meta.headers['etag']).toBe('"abc123"');
    });

    it('ctx.setETag 支持弱 ETag', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setETag('W/"xyz789"');
      expect((ctx as any).meta.headers['etag']).toBe('W/"xyz789"');
    });

    it('ctx.setETag 与 ctx.setHeader 不冲突', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setHeader('X-Custom', 'value');
      ctx.setETag('"v1"');
      expect((ctx as any).meta.headers['X-Custom']).toBe('value');
      expect((ctx as any).meta.headers['etag']).toBe('"v1"');
    });
  });
});
