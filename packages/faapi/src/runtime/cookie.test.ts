import { describe, it, expect } from 'vitest';
import { createContext } from './createContext';
import { toResponse } from '../response/toResponse';

describe('Cookie 支持', () => {
  describe('getCookie - 读取 cookie', () => {
    it('从请求中读取单个 cookie', () => {
      const request = new Request('http://localhost/api/test', {
        headers: { cookie: 'token=abc123' },
      });
      const ctx = createContext(request, {});
      expect(ctx.getCookie('token')).toBe('abc123');
    });

    it('从请求中读取多个 cookie', () => {
      const request = new Request('http://localhost/api/test', {
        headers: { cookie: 'token=abc123; session=xyz789' },
      });
      const ctx = createContext(request, {});
      expect(ctx.getCookie('token')).toBe('abc123');
      expect(ctx.getCookie('session')).toBe('xyz789');
    });

    it('不存在的 cookie 返回 undefined', () => {
      const request = new Request('http://localhost/api/test', {
        headers: { cookie: 'token=abc123' },
      });
      const ctx = createContext(request, {});
      expect(ctx.getCookie('nonexistent')).toBeUndefined();
    });

    it('无 Cookie 头时返回 undefined', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      expect(ctx.getCookie('token')).toBeUndefined();
    });

    it('cookie 值包含等号时正确解析', () => {
      const request = new Request('http://localhost/api/test', {
        headers: { cookie: 'data=key=value' },
      });
      const ctx = createContext(request, {});
      expect(ctx.getCookie('data')).toBe('key=value');
    });
  });

  describe('cookies 属性 - 所有 cookie 键值对', () => {
    it('返回所有 cookie 的 Record', () => {
      const request = new Request('http://localhost/api/test', {
        headers: { cookie: 'token=abc123; session=xyz789' },
      });
      const ctx = createContext(request, {});
      expect(ctx.cookies).toEqual({ token: 'abc123', session: 'xyz789' });
    });

    it('无 Cookie 头时返回空对象', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      expect(ctx.cookies).toEqual({});
    });
  });

  describe('setCookie - 设置 cookie', () => {
    it('设置简单 cookie', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setCookie('token', 'abc123');
      expect((ctx as any).meta.setCookies).toEqual(['token=abc123']);
    });

    it('设置多个 cookie', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setCookie('token', 'abc123');
      ctx.setCookie('session', 'xyz789');
      expect((ctx as any).meta.setCookies).toEqual(['token=abc123', 'session=xyz789']);
    });

    it('设置带 domain 的 cookie', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setCookie('token', 'abc123', { domain: 'example.com' });
      expect((ctx as any).meta.setCookies).toEqual(['token=abc123; Domain=example.com']);
    });

    it('设置带 path 的 cookie', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setCookie('token', 'abc123', { path: '/api' });
      expect((ctx as any).meta.setCookies).toEqual(['token=abc123; Path=/api']);
    });

    it('设置带 maxAge 的 cookie', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setCookie('token', 'abc123', { maxAge: 3600 });
      expect((ctx as any).meta.setCookies).toEqual(['token=abc123; Max-Age=3600']);
    });

    it('设置带 expires 的 cookie', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      const expires = new Date('2025-12-31T23:59:59Z');
      ctx.setCookie('token', 'abc123', { expires });
      expect((ctx as any).meta.setCookies[0]).toContain('token=abc123; Expires=');
    });

    it('设置 httpOnly cookie', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setCookie('token', 'abc123', { httpOnly: true });
      expect((ctx as any).meta.setCookies).toEqual(['token=abc123; HttpOnly']);
    });

    it('设置 secure cookie', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setCookie('token', 'abc123', { secure: true });
      expect((ctx as any).meta.setCookies).toEqual(['token=abc123; Secure']);
    });

    it('设置 sameSite cookie', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setCookie('token', 'abc123', { sameSite: 'Strict' });
      expect((ctx as any).meta.setCookies).toEqual(['token=abc123; SameSite=Strict']);
    });

    it('设置带所有选项的 cookie', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setCookie('token', 'abc123', {
        domain: 'example.com',
        path: '/api',
        maxAge: 3600,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      });
      const cookie = (ctx as any).meta.setCookies[0] as string;
      expect(cookie).toContain('token=abc123');
      expect(cookie).toContain('Domain=example.com');
      expect(cookie).toContain('Path=/api');
      expect(cookie).toContain('Max-Age=3600');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
    });
  });

  describe('deleteCookie - 删除 cookie', () => {
    it('删除 cookie 设置 Max-Age=0', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.deleteCookie('token');
      expect((ctx as any).meta.setCookies).toEqual(['token=; Max-Age=0']);
    });

    it('删除 cookie 与 setCookie 共存', () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setCookie('session', 'new');
      ctx.deleteCookie('token');
      expect((ctx as any).meta.setCookies).toEqual(['session=new', 'token=; Max-Age=0']);
    });
  });

  describe('Set-Cookie 在 Response 中的传递', () => {
    it('setCookie 通过 toResponse 正确设置 Set-Cookie 头', async () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setCookie('token', 'abc123');
      const meta = (ctx as any).meta;
      const res = await toResponse({ ok: true }, meta);
      const setCookies = res.headers.getSetCookie();
      expect(setCookies).toContain('token=abc123');
    });

    it('多个 Set-Cookie 在 Response 中正确传递', async () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setCookie('token', 'abc123');
      ctx.setCookie('session', 'xyz789');
      const meta = (ctx as any).meta;
      const res = await toResponse({ ok: true }, meta);
      const setCookies = res.headers.getSetCookie();
      expect(setCookies).toHaveLength(2);
      expect(setCookies).toContain('token=abc123');
      expect(setCookies).toContain('session=xyz789');
    });

    it('deleteCookie 通过 toResponse 正确设置 Set-Cookie 头', async () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.deleteCookie('token');
      const meta = (ctx as any).meta;
      const res = await toResponse({ ok: true }, meta);
      const setCookies = res.headers.getSetCookie();
      expect(setCookies).toContain('token=; Max-Age=0');
    });

    it('setCookie 带选项通过 toResponse 正确传递', async () => {
      const request = new Request('http://localhost/api/test');
      const ctx = createContext(request, {});
      ctx.setCookie('token', 'abc123', { httpOnly: true, secure: true, sameSite: 'Strict' });
      const meta = (ctx as any).meta;
      const res = await toResponse({ ok: true }, meta);
      const setCookies = res.headers.getSetCookie();
      expect(setCookies[0]).toBe('token=abc123; HttpOnly; Secure; SameSite=Strict');
    });
  });

  describe('cookies 参数注入', () => {
    it('通过 injectParams 注入 cookies', async () => {
      const { injectParamsAsync } = await import('../injection/injectParams.js');
      const request = new Request('http://localhost/api/test', {
        headers: { cookie: 'token=abc123; session=xyz789' },
      });
      const ctx = createContext(request, {});
      const fn = eval('(cookies) => cookies');
      const result = await injectParamsAsync(fn, ctx);
      expect(result).toEqual({ token: 'abc123', session: 'xyz789' });
    });

    it('cookies 注入与其他注入混合使用', async () => {
      const { injectParamsAsync } = await import('../injection/injectParams.js');
      const request = new Request('http://localhost/api/test?search=hello', {
        headers: { cookie: 'token=abc123' },
      });
      const ctx = createContext(request, {});
      const fn = eval('(query, cookies) => ({ query, cookies })');
      const result = (await injectParamsAsync(fn, ctx)) as { query: unknown; cookies: unknown };
      expect(result.query).toEqual({ search: 'hello' });
      expect(result.cookies).toEqual({ token: 'abc123' });
    });
  });
});
