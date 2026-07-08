import { describe, it, expect } from 'vitest';
import type { FaapiMiddleware, InjectorMap } from './index';
import { createContext, invokeHandler } from './index';

/**
 * 业务方测试支持：公开导出 createContext / invokeHandler
 *
 * 验证业务方可在不启动服务器、不依赖 build 产物的前提下，走框架真实的注入、中间件、序列化逻辑。
 */

describe('业务方测试支持', () => {
  describe('createContext', () => {
    it('从 Request 创建 ctx，含 query/headers/method/path', () => {
      const ctx = createContext(
        new Request('http://localhost/api/user?page=1&pageSize=10', {
          headers: { 'x-custom': 'yes' },
        }),
        {},
      );
      expect(ctx.method).toBe('GET');
      expect(ctx.path).toBe('/api/user');
      expect(ctx.query.get('page')).toBe('1');
      expect(ctx.query.get('pageSize')).toBe('10');
      expect(ctx.headers.get('x-custom')).toBe('yes');
    });

    it('注入 params（动态路由参数）', () => {
      const ctx = createContext(new Request('http://localhost/api/user/123'), { id: '123' });
      expect(ctx.params).toEqual({ id: '123' });
    });

    it('注入业务 config', () => {
      const ctx = createContext(
        new Request('http://localhost/'),
        {},
        {
          db: { host: 'localhost', port: 5432 },
        },
      );
      expect(ctx.config.db).toEqual({ host: 'localhost', port: 5432 });
    });

    it('注入 ip', () => {
      const ctx = createContext(new Request('http://localhost/'), {}, {}, '1.2.3.4');
      expect(ctx.ip).toBe('1.2.3.4');
    });

    it('解析 cookie 头', () => {
      const ctx = createContext(
        new Request('http://localhost/', {
          headers: { cookie: 'session=abc; theme=dark' },
        }),
        {},
      );
      expect(ctx.cookies.session).toBe('abc');
      expect(ctx.cookies.theme).toBe('dark');
      expect(ctx.getCookie('session')).toBe('abc');
    });
  });

  describe('invokeHandler', () => {
    it('GET handler 走 query 注入', async () => {
      const ctx = createContext(new Request('http://localhost/api/test?page=2&pageSize=20'), {});
      const handler = (query: any) => ({ page: query.page, pageSize: query.pageSize });
      const res = await invokeHandler(handler, ctx);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ page: '2', pageSize: '20' });
    });

    it('POST handler 走 body 注入', async () => {
      const ctx = createContext(new Request('http://localhost/api/test', { method: 'POST' }), {});
      const handler = (body: any) => ({ created: true, name: body.name });
      const res = await invokeHandler(handler, ctx, { name: 'Alice' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ created: true, name: 'Alice' });
    });

    it('handler 通过参数名注入接收 ctx', async () => {
      const ctx = createContext(new Request('http://localhost/api/test'), {});
      let receivedCtx: unknown;
      const handler = (context: any) => {
        receivedCtx = context;
        return { ok: true };
      };
      await invokeHandler(handler, ctx);
      expect(receivedCtx).toBe(ctx);
    });

    it('handler 通过参数名注入接收 params', async () => {
      const ctx = createContext(new Request('http://localhost/api/user/123'), { id: '123' });
      const handler = (params: any) => ({ id: params.id });
      const res = await invokeHandler(handler, ctx);
      expect(await res.json()).toEqual({ id: '123' });
    });

    it('handler 返回 null 时转为 204', async () => {
      const ctx = createContext(new Request('http://localhost/api/test'), {});
      const res = await invokeHandler(() => null, ctx);
      expect(res.status).toBe(204);
    });

    it('handler 通过 ctx.json 返回自定义响应', async () => {
      const ctx = createContext(new Request('http://localhost/api/test'), {});
      function handler(context: any) {
        return context.json({ error: 'Not found' }, 404);
      }
      const res = await invokeHandler(handler, ctx);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    });

    it('handler 抛错时错误向上传播', async () => {
      const ctx = createContext(new Request('http://localhost/api/test'), {});
      const handler = () => {
        throw new Error('handler error');
      };
      await expect(invokeHandler(handler, ctx)).rejects.toThrow('handler error');
    });

    it('带中间件：鉴权通过', async () => {
      const ctx = createContext(
        new Request('http://localhost/api/admin', {
          headers: { authorization: 'Bearer xxx' },
        }),
        {},
      );
      const authMiddleware: FaapiMiddleware = async (ctx, next) => {
        if (!ctx.headers.get('authorization')) {
          return new Response('Unauthorized', { status: 401 });
        }
        await next();
      };
      const handler = () => ({ ok: true });
      const res = await invokeHandler(handler, ctx, undefined, [authMiddleware]);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it('带中间件：鉴权失败被拦截', async () => {
      const ctx = createContext(new Request('http://localhost/api/admin'), {});
      const authMiddleware: FaapiMiddleware = async (ctx, next) => {
        if (!ctx.headers.get('authorization')) {
          return new Response('Unauthorized', { status: 401 });
        }
        await next();
      };
      const handler = () => ({ ok: true });
      const res = await invokeHandler(handler, ctx, undefined, [authMiddleware]);
      expect(res.status).toBe(401);
    });

    it('带注入器：自定义参数注入', async () => {
      const ctx = createContext(new Request('http://localhost/api/test'), {});
      const mockDb = { query: () => 'result' };
      const injectors: InjectorMap = {
        db: () => mockDb,
      };
      const handler = (db: any) => ({ result: db.query() });
      const res = await invokeHandler(handler, ctx, undefined, undefined, injectors);
      expect(await res.json()).toEqual({ result: 'result' });
    });

    it('async handler 正确 await', async () => {
      const ctx = createContext(new Request('http://localhost/api/test'), {});
      const handler = async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { async: true };
      };
      const res = await invokeHandler(handler, ctx);
      expect(await res.json()).toEqual({ async: true });
    });
  });
});
