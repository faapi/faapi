import { describe, it, expect } from 'vitest';
import { injectParamsAsync } from './injectParams';
import type { FaapiContext } from '../runtime/contextTypes';
import type { MultipartResult } from '../utils/parseMultipart';

describe('injectParams', () => {
  const createMockContext = (overrides?: Partial<FaapiContext>): FaapiContext => {
    const url = new URL('http://localhost:3000/test?page=1&pageSize=10');
    return {
      request: new Request(url),
      params: { id: '123' },
      query: url.searchParams,
      headers: new Headers({ authorization: 'Bearer token' }),
      method: 'GET',
      path: '/test',
      // 以下字段在 injectParams 测试中不会被读取，提供空实现以满足 FaapiContext 类型
      cookies: {},
      config: {} as Record<string, unknown>,
      setStatus() {},
      setHeader() {},
      json: (data) => new Response(JSON.stringify(data)),
      html: (html) => new Response(html),
      redirect: (url) => new Response(null, { status: 302, headers: { Location: url } }),
      sse: () => {
        throw new Error('sse() not supported in injectParams test mock');
      },
      getCookie: () => undefined,
      setCookie: () => {},
      deleteCookie: () => {},
      ...overrides,
    } as FaapiContext;
  };

  describe('单参数注入', () => {
    it('注入 query', async () => {
      const ctx = createMockContext();
      const fn = eval('(query) => query');
      const result = await injectParamsAsync(fn, ctx);
      expect(result).toEqual({ page: '1', pageSize: '10' });
    });

    it('注入 params', async () => {
      const ctx = createMockContext();
      const fn = eval('(params) => params');
      const result = await injectParamsAsync(fn, ctx);
      expect(result).toEqual({ id: '123' });
    });

    it('注入 headers', async () => {
      const ctx = createMockContext();
      const fn = eval('(headers) => headers');
      const result = await injectParamsAsync(fn, ctx);
      expect(result).toBeInstanceOf(Headers);
    });

    it('注入 context', async () => {
      const ctx = createMockContext();
      const fn = eval('(context) => context');
      const result = await injectParamsAsync(fn, ctx);
      expect(result).toBe(ctx);
    });
  });

  describe('多参数注入', () => {
    it('注入多个参数', async () => {
      const ctx = createMockContext();
      const fn = eval('(query, params) => ({ query, params })');
      const result = (await injectParamsAsync(fn, ctx)) as { query: unknown; params: unknown };
      expect(result.query).toEqual({ page: '1', pageSize: '10' });
      expect(result.params).toEqual({ id: '123' });
    });

    it('顺序不固定', async () => {
      const ctx = createMockContext();
      const fn = eval('(params, query) => ({ params, query })');
      const result = (await injectParamsAsync(fn, ctx)) as { query: unknown; params: unknown };
      expect(result.query).toEqual({ page: '1', pageSize: '10' });
      expect(result.params).toEqual({ id: '123' });
    });
  });

  describe('body 注入', () => {
    it('传入 body 参数', async () => {
      const body = { name: 'John', age: 30 };
      const request = new Request('http://localhost:3000/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const ctx = createMockContext({ request, method: 'POST' });

      const fn = eval('(body) => body');
      const result = await injectParamsAsync(fn, ctx, body);
      expect(result).toEqual(body);
    });
  });

  describe('form 注入', () => {
    it('form 参数与 body 共享解析结果', async () => {
      // resolveInput 对 application/x-www-form-urlencoded 解析为 Record<string, string>
      const body = { username: 'alice', remember: 'true' };
      const request = new Request('http://localhost:3000/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const ctx = createMockContext({ request, method: 'POST' });

      const fn = eval('(form) => form');
      const result = await injectParamsAsync(fn, ctx, body);
      // form 共享 body 的解析结果（同一对象引用）
      expect(result).toEqual(body);
      expect(result).toBe(body);
    });

    it('body 为 undefined 时 form 也为 undefined', async () => {
      const ctx = createMockContext({ method: 'POST' });
      const fn = eval('(form) => form');
      const result = await injectParamsAsync(fn, ctx, undefined);
      expect(result).toBeUndefined();
    });
  });

  describe('files 注入', () => {
    const createMultipartBody = (overrides?: Partial<MultipartResult>): MultipartResult => ({
      files: [
        {
          name: 'avatar',
          filename: 'avatar.png',
          type: 'image/png',
          size: 1024,
          arrayBuffer: async () => new ArrayBuffer(1024),
        },
      ],
      fields: { name: 'John' },
      ...overrides,
    });

    it('body 为 MultipartResult 时注入 files 列表', async () => {
      const body = createMultipartBody();
      const ctx = createMockContext({ method: 'POST' });
      const fn = eval('(files) => files');
      const result = (await injectParamsAsync(fn, ctx, body)) as unknown[];
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(body.files[0]);
    });

    it('body 非 MultipartResult 时返回空数组', async () => {
      const body = { name: 'John' }; // 普通 JSON 对象
      const ctx = createMockContext({ method: 'POST' });
      const fn = eval('(files) => files');
      const result = await injectParamsAsync(fn, ctx, body);
      expect(result).toEqual([]);
    });

    it('body 为 undefined 时返回空数组', async () => {
      const ctx = createMockContext();
      const fn = eval('(files) => files');
      const result = await injectParamsAsync(fn, ctx);
      expect(result).toEqual([]);
    });
  });

  describe('fields 注入', () => {
    const createMultipartBody = (overrides?: Partial<MultipartResult>): MultipartResult => ({
      files: [],
      fields: { name: 'John', age: '30' },
      ...overrides,
    });

    it('body 为 MultipartResult 时注入 fields 对象', async () => {
      const body = createMultipartBody();
      const ctx = createMockContext({ method: 'POST' });
      const fn = eval('(fields) => fields');
      const result = (await injectParamsAsync(fn, ctx, body)) as Record<string, unknown>;
      expect(result).toEqual({ name: 'John', age: '30' });
    });

    it('body 非 MultipartResult 时返回空对象', async () => {
      const body = { name: 'John' };
      const ctx = createMockContext({ method: 'POST' });
      const fn = eval('(fields) => fields');
      const result = await injectParamsAsync(fn, ctx, body);
      expect(result).toEqual({});
    });

    it('files 和 fields 同时注入', async () => {
      const body: MultipartResult = {
        files: [
          {
            name: 'avatar',
            filename: 'avatar.png',
            type: 'image/png',
            size: 1024,
            arrayBuffer: async () => new ArrayBuffer(1024),
          },
        ],
        fields: { name: 'John' },
      };
      const ctx = createMockContext({ method: 'POST' });
      const fn = eval('(files, fields) => ({ files, fields })');
      const result = (await injectParamsAsync(fn, ctx, body)) as {
        files: unknown[];
        fields: Record<string, unknown>;
      };
      expect(result.files).toHaveLength(1);
      expect(result.fields).toEqual({ name: 'John' });
    });
  });

  describe('cookies 注入', () => {
    it('注入 cookies 对象', async () => {
      const ctx = createMockContext({ cookies: { session: 'abc123', theme: 'dark' } });
      const fn = eval('(cookies) => cookies');
      const result = await injectParamsAsync(fn, ctx);
      expect(result).toEqual({ session: 'abc123', theme: 'dark' });
    });

    it('无 Cookie 时注入空对象', async () => {
      const ctx = createMockContext({ cookies: {} });
      const fn = eval('(cookies) => cookies');
      const result = await injectParamsAsync(fn, ctx);
      expect(result).toEqual({});
    });

    it('cookies 与 query 混合注入', async () => {
      const ctx = createMockContext({ cookies: { session: 'abc' } });
      const fn = eval('(query, cookies) => ({ query, cookies })');
      const result = (await injectParamsAsync(fn, ctx)) as {
        query: unknown;
        cookies: unknown;
      };
      expect(result.query).toEqual({ page: '1', pageSize: '10' });
      expect(result.cookies).toEqual({ session: 'abc' });
    });
  });

  describe('ctx 别名注入', () => {
    it('ctx 参数注入 context 对象（与 context 行为一致）', async () => {
      const ctx = createMockContext();
      const fn = eval('(ctx) => ctx');
      const result = await injectParamsAsync(fn, ctx);
      expect(result).toBe(ctx);
    });

    it('ctx 与其他参数混合', async () => {
      const ctx = createMockContext();
      const fn = eval('(query, ctx) => ({ query, ctx })');
      const result = (await injectParamsAsync(fn, ctx)) as {
        query: unknown;
        ctx: unknown;
      };
      expect(result.query).toEqual({ page: '1', pageSize: '10' });
      expect(result.ctx).toBe(ctx);
    });
  });

  describe('注入器注入', () => {
    it('通过注入器注入自定义参数', async () => {
      const ctx = createMockContext();
      const injectors = { db: () => ({ connected: true }) };
      const fn = eval('(db) => db');
      const result = (await injectParamsAsync(fn, ctx, undefined, injectors)) as any;
      expect(result.connected).toBe(true);
    });

    it('内置注入优先于注入器', async () => {
      const ctx = createMockContext();
      const injectors = { query: () => 'from-injector' };
      const fn = eval('(query) => query');
      const result = await injectParamsAsync(fn, ctx, undefined, injectors);
      // 内置 query 注入优先
      expect(result).toEqual({ page: '1', pageSize: '10' });
    });

    it('内置和注入器混合注入', async () => {
      const ctx = createMockContext();
      const injectors = { db: () => 'mock-db' };
      const fn = eval('(query, db) => ({ query, db })');
      const result = (await injectParamsAsync(fn, ctx, undefined, injectors)) as {
        query: unknown;
        db: unknown;
      };
      expect(result.query).toEqual({ page: '1', pageSize: '10' });
      expect(result.db).toBe('mock-db');
    });

    it('不匹配的参数名返回 undefined', async () => {
      const ctx = createMockContext();
      const injectors = { db: () => 'mock-db' };
      const fn = eval('(unknownParam) => unknownParam');
      const result = await injectParamsAsync(fn, ctx, undefined, injectors);
      expect(result).toBeUndefined();
    });

    it('注入器支持异步', async () => {
      const ctx = createMockContext();
      const injectors = {
        db: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { connected: true };
        },
      };
      const fn = eval('(db) => db');
      const result = (await injectParamsAsync(fn, ctx, undefined, injectors)) as any;
      expect(result.connected).toBe(true);
    });

    it('注入器可读取 ctx', async () => {
      const ctx = createMockContext();
      const injectors = {
        user: (c: any) => c.headers.get('authorization'),
      };
      const fn = eval('(user) => user');
      const result = await injectParamsAsync(fn, ctx, undefined, injectors);
      expect(result).toBe('Bearer token');
    });

    it('注入器返回 null 时 handler 收到 null', async () => {
      const ctx = createMockContext();
      const injectors = { db: () => null };
      const fn = eval('(db) => db');
      const result = await injectParamsAsync(fn, ctx, undefined, injectors);
      expect(result).toBeNull();
    });

    it('同步注入器抛错时错误向上传播', async () => {
      const ctx = createMockContext();
      const injectors = {
        db: () => {
          throw new Error('db connection failed');
        },
      };
      const fn = eval('(db) => db');
      await expect(injectParamsAsync(fn, ctx, undefined, injectors)).rejects.toThrow(
        'db connection failed',
      );
    });

    it('异步注入器 reject 时错误向上传播', async () => {
      const ctx = createMockContext();
      const injectors = {
        db: async () => {
          throw new Error('async db fail');
        },
      };
      const fn = eval('(db) => db');
      await expect(injectParamsAsync(fn, ctx, undefined, injectors)).rejects.toThrow(
        'async db fail',
      );
    });

    it('注入器抛错后 handler 不执行', async () => {
      const ctx = createMockContext();
      const handlerCalled = { value: false };
      const injectors = {
        db: () => {
          throw new Error('fail');
        },
      };
      const fn = eval('(db) => { handlerCalled.value = true; return db; }');
      try {
        await injectParamsAsync(fn, ctx, undefined, injectors);
      } catch {
        // 忽略错误
      }
      expect(handlerCalled.value).toBe(false);
    });
  });

  describe('边界情况', () => {
    it('无参数函数直接调用', async () => {
      const ctx = createMockContext();
      const fn = eval('() => "result"');
      const result = await injectParamsAsync(fn, ctx);
      expect(result).toBe('result');
    });

    it('支持 async 函数', async () => {
      const ctx = createMockContext();
      const fn = eval('async (query) => query');
      const result = await injectParamsAsync(fn, ctx);
      expect(result).toEqual({ page: '1', pageSize: '10' });
    });
  });
});
