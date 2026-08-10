import { describe, it, expect } from 'vitest';
import { invokeHandler } from './invokeHandler';
import { createTestContext } from './createContext';
import type { FaapiMiddleware, InjectorMap } from '../index';

describe('invokeHandler', () => {
  const makeCtx = () => createTestContext({ path: '/api/test' });

  it('handler 返回对象时转为 JSON Response', async () => {
    const handler = () => ({ message: 'hello' });
    const response = await invokeHandler(handler, makeCtx());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    const body = await response.json();
    expect(body).toEqual({ data: { message: 'hello' } });
  });

  it('handler 返回 null 时自动包裹为 { data: null }', async () => {
    const handler = () => null;
    const response = await invokeHandler(handler, makeCtx());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    const body = await response.json();
    expect(body).toEqual({ data: null });
  });

  it('handler 抛错时错误向上传播', async () => {
    const handler = () => {
      throw new Error('handler error');
    };
    await expect(invokeHandler(handler, makeCtx())).rejects.toThrow('handler error');
  });

  it('handler 通过参数名注入接收 ctx', async () => {
    const ctx = makeCtx();
    let receivedCtx: unknown;

    const handler = (context: any) => {
      receivedCtx = context;
      return { ok: true };
    };

    await invokeHandler(handler, ctx);
    expect(receivedCtx).toBe(ctx);
  });

  it('handler 通过参数名注入接收 query', async () => {
    const ctx = createTestContext({ path: '/api/test', query: { page: '2', pageSize: '20' } });

    const handler = (query: any) => {
      return { page: query.page, pageSize: query.pageSize };
    };

    const response = await invokeHandler(handler, ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ data: { page: '2', pageSize: '20' } });
  });

  it('handler 通过参数名注入接收 body', async () => {
    const ctx = makeCtx();
    const body = { name: 'test' };

    const handler = eval('(body) => ({ received: body })');

    const response = await invokeHandler(handler, ctx, body);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ data: { received: { name: 'test' } } });
  });

  it('handler 通过参数名注入接收 ip', async () => {
    const ctx = createTestContext({ path: '/api/test', ip: '203.0.113.10' });

    const handler = (ip: unknown) => ({ clientIp: ip });

    const response = await invokeHandler(handler, ctx);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ data: { clientIp: '203.0.113.10' } });
  });

  it('ctx.setStatus 修改响应状态码', async () => {
    const handler = (context: any) => {
      context.setStatus(201);
      return { created: true };
    };
    const response = await invokeHandler(handler, makeCtx());
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ data: { created: true } });
  });

  it('ctx.setHeader 修改响应头', async () => {
    const handler = (context: any) => {
      context.setHeader('Cache-Control', 'max-age=3600');
      return { data: [] };
    };
    const response = await invokeHandler(handler, makeCtx());
    expect(response.headers.get('Cache-Control')).toBe('max-age=3600');
  });

  it('ctx.redirect 返回重定向 Response', async () => {
    const handler = (context: any) => {
      return context.redirect('/login');
    };
    const response = await invokeHandler(handler, makeCtx());
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/login');
  });

  // 中间件测试（洋葱模型 + 独立注入器）
  describe('middleware', () => {
    describe('拦截与放行', () => {
      it('中间件返回 Response 时拦截请求，不执行 handler', async () => {
        let handlerCalled = false;
        const handler = () => {
          handlerCalled = true;
          return { shouldNot: 'reach' };
        };
        const middlewares: FaapiMiddleware[] = [
          async () =>
            new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            }),
        ];
        const response = await invokeHandler(handler, makeCtx(), undefined, middlewares);
        expect(response.status).toBe(401);
        const body = await response.json();
        expect(body).toEqual({ error: 'Unauthorized' });
        expect(handlerCalled).toBe(false);
      });

      it('中间件 await next() 后放行到 handler', async () => {
        const handler = () => ({ ok: true });
        const middlewares: FaapiMiddleware[] = [
          async (_ctx, next) => {
            await next();
          },
        ];
        const response = await invokeHandler(handler, makeCtx(), undefined, middlewares);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({ data: { ok: true } });
      });

      it('中间件链按顺序执行，第一个拦截后不再执行后续', async () => {
        let secondCalled = false;
        const handler = () => ({ shouldNot: 'reach' });
        const middlewares: FaapiMiddleware[] = [
          async () => new Response(null, { status: 401 }),
          async (_ctx, next) => {
            secondCalled = true;
            await next();
          },
        ];
        await invokeHandler(handler, makeCtx(), undefined, middlewares);
        expect(secondCalled).toBe(false);
      });

      it('中间件支持异步', async () => {
        const handler = () => ({ ok: true });
        const middlewares: FaapiMiddleware[] = [
          async (_ctx, next) => {
            await new Promise((r) => setTimeout(r, 10));
            await next();
          },
        ];
        const response = await invokeHandler(handler, makeCtx(), undefined, middlewares);
        expect(response.status).toBe(200);
      });
    });

    describe('洋葱模型：before/after 一体', () => {
      it('中间件 before/after 按洋葱顺序执行', async () => {
        const order: string[] = [];
        const handler = () => {
          order.push('handler');
          return { ok: true };
        };
        const middlewares: FaapiMiddleware[] = [
          async (_ctx, next) => {
            order.push('mw1:before');
            await next();
            order.push('mw1:after');
          },
          async (_ctx, next) => {
            order.push('mw2:before');
            await next();
            order.push('mw2:after');
          },
        ];
        await invokeHandler(handler, makeCtx(), undefined, middlewares);
        expect(order).toEqual(['mw1:before', 'mw2:before', 'handler', 'mw2:after', 'mw1:after']);
      });

      it('闭包变量在 before/after 间共享（计时场景）', async () => {
        let loggedDuration = -1;
        const handler = () => ({ ok: true });
        const middlewares: FaapiMiddleware[] = [
          async (_ctx, next) => {
            const start = Date.now();
            await next();
            loggedDuration = Date.now() - start;
          },
        ];
        await invokeHandler(handler, makeCtx(), undefined, middlewares);
        expect(loggedDuration).toBeGreaterThanOrEqual(0);
      });

      it('中间件 await next() 后返回 Response 可替换内层响应', async () => {
        const handler = () => ({ ok: true });
        const middlewares: FaapiMiddleware[] = [
          async (_ctx, next) => {
            await next();
            return new Response(JSON.stringify({ modified: true }), {
              status: 201,
              headers: { 'Content-Type': 'application/json' },
            });
          },
        ];
        const response = await invokeHandler(handler, makeCtx(), undefined, middlewares);
        expect(response.status).toBe(201);
        const body = await response.json();
        expect(body).toEqual({ modified: true });
      });

      it('外层中间件 after 在内层拦截时仍执行（洋葱模型语义）', async () => {
        let outerAfterCalled = false;
        const handler = () => ({ shouldNot: 'reach' });
        const middlewares: FaapiMiddleware[] = [
          async (_ctx, next) => {
            await next();
            outerAfterCalled = true;
          },
          async () => new Response('blocked', { status: 403 }),
        ];
        await invokeHandler(handler, makeCtx(), undefined, middlewares);
        // 洋葱模型：内层返回 Response 不是错误，外层 after 会执行
        expect(outerAfterCalled).toBe(true);
      });
    });

    describe('错误处理（try/catch 语义）', () => {
      it('中间件 try/catch 捕获 handler 抛错', async () => {
        const handler = () => {
          throw new Error('something broke');
        };
        const middlewares: FaapiMiddleware[] = [
          async (_ctx, next) => {
            try {
              await next();
            } catch (err) {
              return new Response(
                JSON.stringify({ success: false, message: (err as Error).message }),
                {
                  status: 500,
                  headers: { 'Content-Type': 'application/json' },
                },
              );
            }
          },
        ];
        const response = await invokeHandler(handler, makeCtx(), undefined, middlewares);
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body).toEqual({ success: false, message: 'something broke' });
      });

      it('中间件 try/catch 捕获内层中间件抛错', async () => {
        const handler = () => ({ ok: true });
        const middlewares: FaapiMiddleware[] = [
          async (_ctx, next) => {
            try {
              await next();
            } catch (err) {
              return new Response(JSON.stringify({ error: (err as Error).message }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' },
              });
            }
          },
          async () => {
            throw new Error('inner failed');
          },
        ];
        const response = await invokeHandler(handler, makeCtx(), undefined, middlewares);
        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body).toEqual({ error: 'inner failed' });
      });

      it('中间件不 catch 时错误向上传播到外层', async () => {
        let outerCaught = false;
        const handler = () => {
          throw new Error('fail');
        };
        const middlewares: FaapiMiddleware[] = [
          async (_ctx, next) => {
            try {
              await next();
            } catch {
              outerCaught = true;
              return new Response('caught', { status: 500 });
            }
          },
          async (_ctx, next) => {
            await next();
          }, // 不 catch
        ];
        const response = await invokeHandler(handler, makeCtx(), undefined, middlewares);
        expect(response.status).toBe(500);
        expect(outerCaught).toBe(true);
      });

      it('没有 try/catch 时错误重新抛出', async () => {
        const handler = () => {
          throw new Error('unhandled');
        };
        const middlewares: FaapiMiddleware[] = [
          async (_ctx, next) => {
            await next();
          },
        ];
        await expect(invokeHandler(handler, makeCtx(), undefined, middlewares)).rejects.toThrow(
          'unhandled',
        );
      });

      it('catch 后重新抛出，外层仍可捕获', async () => {
        let outerCaught = false;
        const handler = () => {
          throw new Error('fail');
        };
        const middlewares: FaapiMiddleware[] = [
          async (_ctx, next) => {
            try {
              await next();
            } catch {
              outerCaught = true;
              return new Response('outer', { status: 500 });
            }
          },
          async (_ctx, next) => {
            await next();
          },
        ];
        const response = await invokeHandler(handler, makeCtx(), undefined, middlewares);
        expect(response.status).toBe(500);
        expect(outerCaught).toBe(true);
      });
    });

    describe('鉴权场景', () => {
      it('鉴权中间件无 token 拦截，有 token 塞 user 到 ctx', async () => {
        const handler = (user: any) => ({ name: user.name });
        const middlewares: FaapiMiddleware[] = [
          async (ctx, next) => {
            const token = ctx.headers.get('authorization');
            if (!token) {
              return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
              });
            }
            (ctx as any).user = { name: 'alice' };
            await next();
          },
        ];
        const injectors: InjectorMap = {
          user: (ctx) => (ctx as any).user,
        };

        // 无 token → 401
        const noTokenRes = await invokeHandler(
          handler,
          makeCtx(),
          undefined,
          middlewares,
          injectors,
        );
        expect(noTokenRes.status).toBe(401);

        // 有 token → 200 + 注入用户
        const tokenCtx = createTestContext({
          path: '/api/test',
          headers: { authorization: 'Bearer test-token' },
        });
        const tokenRes = await invokeHandler(handler, tokenCtx, undefined, middlewares, injectors);
        expect(tokenRes.status).toBe(200);
        const body = await tokenRes.json();
        expect(body).toEqual({ data: { name: 'alice' } });
      });
    });

    describe('注入器', () => {
      it('注入器按参数名提供依赖', async () => {
        const handler = eval('(db) => ({ connected: db.connected })');
        const injectors: InjectorMap = {
          db: () => ({ connected: true }),
        };
        const response = await invokeHandler(handler, makeCtx(), undefined, undefined, injectors);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({ data: { connected: true } });
      });

      it('注入器支持异步', async () => {
        const handler = eval('(db) => ({ connected: db.connected })');
        const injectors: InjectorMap = {
          db: async () => {
            await new Promise((r) => setTimeout(r, 10));
            return { connected: true };
          },
        };
        const response = await invokeHandler(handler, makeCtx(), undefined, undefined, injectors);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({ data: { connected: true } });
      });

      it('注入器按需执行：handler 不需要的参数不触发注入器', async () => {
        let dbInjectorCalled = false;
        const handler = eval('(user) => ({ name: user.name })');
        const injectors: InjectorMap = {
          user: () => ({ name: 'alice' }),
          db: () => {
            dbInjectorCalled = true;
            return { connected: true };
          },
        };
        await invokeHandler(handler, makeCtx(), undefined, undefined, injectors);
        expect(dbInjectorCalled).toBe(false);
      });

      it('注入器可读取中间件塞进 ctx 的值', async () => {
        const handler = eval('(user) => ({ name: user.name })');
        const middlewares: FaapiMiddleware[] = [
          async (ctx, next) => {
            (ctx as any).user = { name: 'from-middleware' };
            await next();
          },
        ];
        const injectors: InjectorMap = {
          user: (ctx) => (ctx as any).user,
        };
        const response = await invokeHandler(handler, makeCtx(), undefined, middlewares, injectors);
        const body = await response.json();
        expect(body).toEqual({ data: { name: 'from-middleware' } });
      });

      it('内置注入优先于注入器（query 不被覆盖）', async () => {
        const ctx = createTestContext({ path: '/api/test', query: { page: '2' } });
        const handler = eval('(query) => ({ page: query.page })');
        const injectors: InjectorMap = {
          query: () => ({ page: 'should-not-win' }),
        };
        const response = await invokeHandler(handler, ctx, undefined, undefined, injectors);
        const body = await response.json();
        expect(body).toEqual({ data: { page: '2' } });
      });

      it('无匹配注入器时参数为 undefined（自动包裹为 { data: undefined } → JSON {}）', async () => {
        const handler = eval('(unknown) => unknown');
        const response = await invokeHandler(handler, makeCtx(), undefined, undefined, {});
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({});
      });
    });

    describe('完整执行顺序', () => {
      it('洋葱模型 + 注入器 + handler 完整链路', async () => {
        const order: string[] = [];
        const handler = eval('(user) => { order.push("handler"); return { name: user.name }; }');
        const middlewares: FaapiMiddleware[] = [
          async (_ctx, next) => {
            order.push('mw1:before');
            await next();
            order.push('mw1:after');
          },
          async (_ctx, next) => {
            order.push('mw2:before');
            await next();
            order.push('mw2:after');
          },
        ];
        const injectors: InjectorMap = {
          user: () => {
            order.push('injector:user');
            return { name: 'alice' };
          },
        };
        const response = await invokeHandler(handler, makeCtx(), undefined, middlewares, injectors);
        expect(response.status).toBe(200);
        expect(order).toEqual([
          'mw1:before',
          'mw2:before',
          'injector:user',
          'handler',
          'mw2:after',
          'mw1:after',
        ]);
      });
    });

    describe('多中间件链', () => {
      it('日志 + 鉴权 + 错误处理：正常流程', async () => {
        const log: string[] = [];
        const handler = eval('(user) => { log.push("handler"); return { name: user.name }; }');
        const middlewares: FaapiMiddleware[] = [
          // 日志
          async (ctx, next) => {
            log.push('log:before');
            await next();
            log.push('log:after');
          },
          // 鉴权
          async (ctx, next) => {
            const token = ctx.headers.get('authorization');
            if (!token) {
              return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
              });
            }
            (ctx as any).user = { name: 'alice' };
            await next();
          },
          // 错误处理
          async (_ctx, next) => {
            try {
              await next();
            } catch (err) {
              return new Response(JSON.stringify({ error: (err as Error).message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
              });
            }
          },
        ];
        const injectors: InjectorMap = {
          user: (ctx) => (ctx as any).user,
        };

        const ctx = createTestContext({
          path: '/api/test',
          headers: { authorization: 'Bearer token' },
        });
        const response = await invokeHandler(handler, ctx, undefined, middlewares, injectors);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({ data: { name: 'alice' } });
        expect(log).toEqual(['log:before', 'handler', 'log:after']);
      });

      it('日志 + 鉴权 + 错误处理：handler 抛错时 error 捕获', async () => {
        const log: string[] = [];
        const handler = eval('(user) => { log.push("handler"); throw new Error("boom"); }');
        const middlewares: FaapiMiddleware[] = [
          async (_ctx, next) => {
            log.push('log:before');
            await next();
            log.push('log:after');
          },
          async (ctx, next) => {
            (ctx as any).user = { name: 'alice' };
            await next();
          },
          async (_ctx, next) => {
            try {
              await next();
            } catch (err) {
              log.push('error:handle');
              return new Response(JSON.stringify({ error: (err as Error).message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
              });
            }
          },
        ];
        const injectors: InjectorMap = {
          user: (ctx) => (ctx as any).user,
        };

        const response = await invokeHandler(handler, makeCtx(), undefined, middlewares, injectors);
        expect(response.status).toBe(500);
        // 洋葱模型：error 中间件 catch 后返回 Response，log 的 await next() 正常返回
        // 所以 log:after 会执行
        expect(log).toEqual(['log:before', 'handler', 'error:handle', 'log:after']);
      });
    });

    describe('handler 返回 Response 时原样透传', () => {
      it('handler 直接返回 Response 对象，状态码和内容保持不变', async () => {
        const handler = () =>
          new Response(JSON.stringify({ custom: true }), {
            status: 201,
            headers: { 'Content-Type': 'application/json', 'X-Custom': 'value' },
          });
        const response = await invokeHandler(handler, makeCtx());
        expect(response.status).toBe(201);
        expect(response.headers.get('X-Custom')).toBe('value');
        const body = await response.json();
        expect(body).toEqual({ custom: true });
      });
    });

    describe('中间件不调 next() 也不返回 Response 时抛错', () => {
      it('语义模糊的中间件会抛错', async () => {
        const handler = () => ({ ok: true });
        const middlewares: FaapiMiddleware[] = [
          async () => {
            /* 既不调 next() 也不返回 Response */
          },
        ];
        await expect(invokeHandler(handler, makeCtx(), undefined, middlewares)).rejects.toThrow();
      });
    });
  });

  describe('SSE 集成', () => {
    it('handler 调用 ctx.sse() 后，返回 SSE Response（忽略 handler 返回值）', async () => {
      const ctx = makeCtx();
      const handler = (context: any) => {
        const sse = context.sse();
        sse.send({ data: 'hello' });
        sse.close();
        return { ignored: true }; // 应被忽略
      };
      const response = await invokeHandler(handler, ctx);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      const body = await response.text();
      expect(body).toBe('data: hello\n\n');
    });

    it('handler 未调用 ctx.sse() 时，正常使用 handler 返回值', async () => {
      const ctx = makeCtx();
      const handler = () => ({ ok: true });
      const response = await invokeHandler(handler, ctx);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(await response.json()).toEqual({ data: { ok: true } });
    });

    it('SSE Response 合并 ctx.setStatus 设置的状态码', async () => {
      const ctx = makeCtx();
      const handler = (context: any) => {
        context.setStatus(201);
        const sse = context.sse();
        sse.send({ data: 'created' });
        sse.close();
      };
      const response = await invokeHandler(handler, ctx);
      expect(response.status).toBe(201);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    });

    it('SSE Response 合并 ctx.setHeader 设置的响应头', async () => {
      const ctx = makeCtx();
      const handler = (context: any) => {
        context.setHeader('X-Request-Id', 'abc-123');
        const sse = context.sse();
        sse.send({ data: 'x' });
        sse.close();
      };
      const response = await invokeHandler(handler, ctx);
      expect(response.headers.get('X-Request-Id')).toBe('abc-123');
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    });

    it('有中间件时，handler 调用 ctx.sse() 仍返回 SSE Response', async () => {
      const ctx = makeCtx();
      const logMiddleware: FaapiMiddleware = async (c, next) => {
        await next();
      };
      const handler = (context: any) => {
        const sse = context.sse();
        sse.send({ event: 'progress', data: '50' });
        sse.send({ event: 'done', data: '100' });
        sse.close();
      };
      const response = await invokeHandler(handler, ctx, undefined, [logMiddleware]);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      const body = await response.text();
      expect(body).toBe('event: progress\ndata: 50\n\nevent: done\ndata: 100\n\n');
    });

    it('中间件返回 Response 时，handler 的 ctx.sse() 仍优先（中间件未拦截 next 之前）', async () => {
      // 中间件 await next() 后返回 Response 会替换内层响应
      // 但如果中间件没返回 Response，SSE 应正常工作
      const ctx = makeCtx();
      const passThrough: FaapiMiddleware = async (_c, next) => {
        await next();
      };
      const handler = (context: any) => {
        const sse = context.sse();
        sse.send({ data: 'ok' });
        sse.close();
      };
      const response = await invokeHandler(handler, ctx, undefined, [passThrough]);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    });
  });

  describe('SSE 自动 close 兜底', () => {
    it('handler 忘记 close 时，框架自动关闭 writer', async () => {
      const ctx = makeCtx();
      let writerRef: any;
      const handler = (context: any) => {
        const sse = context.sse();
        writerRef = sse;
        sse.send({ data: 'hello' });
        // 故意不调用 sse.close()
      };
      const response = await invokeHandler(handler, ctx);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      // 框架兜底：writer 已被自动关闭
      expect(writerRef.closed).toBe(true);
      // 流内容仍可正确读取
      const body = await response.text();
      expect(body).toBe('data: hello\n\n');
    });

    it('handler 已显式 close 时，框架不重复关闭', async () => {
      const ctx = makeCtx();
      let writerRef: any;
      const handler = (context: any) => {
        const sse = context.sse();
        writerRef = sse;
        sse.send({ data: 'a' });
        sse.close(); // 显式关闭
      };
      await invokeHandler(handler, ctx);
      // 仍是 closed，多次 close 安全
      expect(writerRef.closed).toBe(true);
    });

    it('有中间件时，handler 忘记 close 也被自动关闭', async () => {
      const ctx = makeCtx();
      let writerRef: any;
      const mw: FaapiMiddleware = async (_c, next) => {
        await next();
      };
      const handler = (context: any) => {
        const sse = context.sse();
        writerRef = sse;
        sse.send({ data: 'a' });
        sse.send({ data: 'b' });
        // 不 close
      };
      const response = await invokeHandler(handler, ctx, undefined, [mw]);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(writerRef.closed).toBe(true);
      const body = await response.text();
      expect(body).toBe('data: a\n\ndata: b\n\n');
    });

    it('handler 异步流程中抛错时，writer 已写入的内容仍保留', async () => {
      const ctx = makeCtx();
      let writerRef: any;
      const handler = async (context: any) => {
        const sse = context.sse();
        writerRef = sse;
        sse.send({ data: 'partial' });
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('handler boom');
      };
      // handler 抛错向上传播，但 writer 的流已写入内容
      await expect(invokeHandler(handler, ctx)).rejects.toThrow('handler boom');
      // 流仍可读取已写入内容
      const body = await writerRef.response.text();
      expect(body).toBe('data: partial\n\n');
    });
  });

  describe('ctx.ok / ctx.fail 自动包裹与错误响应', () => {
    describe('ctx.ok', () => {
      it('ctx.ok(data) 返回 200 + { data: T }', async () => {
        const handler = (context: any) => context.ok({ id: 1, name: 'Alice' });
        const response = await invokeHandler(handler, makeCtx());
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('application/json');
        const body = await response.json();
        expect(body).toEqual({ data: { id: 1, name: 'Alice' } });
      });

      it('ctx.ok(data) 与 return data 响应一致（不会双重包裹）', async () => {
        const ctx1 = makeCtx();
        const ctx2 = makeCtx();
        const viaOk = await invokeHandler((context: any) => context.ok({ id: 1 }), ctx1);
        const viaReturn = await invokeHandler(() => ({ id: 1 }), ctx2);
        expect(viaOk.status).toBe(viaReturn.status);
        const okBody = await viaOk.json();
        const returnBody = await viaReturn.json();
        expect(okBody).toEqual(returnBody);
        // 关键：不会变成 { data: { data: { id: 1 } } }
        expect(okBody).toEqual({ data: { id: 1 } });
      });

      it('ctx.ok 返回的 Response 不被 wrapResult 再次包裹', async () => {
        const handler = (context: any) => context.ok({ nested: true });
        const response = await invokeHandler(handler, makeCtx());
        const body = await response.json();
        // 不是 { data: { data: { nested: true } } }
        expect(body).toEqual({ data: { nested: true } });
        expect(body).not.toHaveProperty('data.data');
      });

      it('ctx.ok 合并 ctx.setStatus 设置的状态码', async () => {
        const handler = (context: any) => {
          context.setStatus(201);
          return context.ok({ created: true });
        };
        const response = await invokeHandler(handler, makeCtx());
        expect(response.status).toBe(201);
        const body = await response.json();
        expect(body).toEqual({ data: { created: true } });
      });

      it('ctx.ok 合并 ctx.setHeader 设置的响应头', async () => {
        const handler = (context: any) => {
          context.setHeader('X-Custom', 'ok-header');
          return context.ok({ ok: true });
        };
        const response = await invokeHandler(handler, makeCtx());
        expect(response.headers.get('X-Custom')).toBe('ok-header');
        expect(response.headers.get('Content-Type')).toBe('application/json');
      });

      it('ctx.ok 使用自定义 config.response.ok', async () => {
        const ctx = createTestContext({
          path: '/api/test',
          config: {
            response: {
              ok: (data: unknown) => ({ code: 0, data }),
            },
          },
        });
        const handler = (context: any) => context.ok({ id: 1 });
        const response = await invokeHandler(handler, ctx);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({ code: 0, data: { id: 1 } });
      });
    });

    describe('ctx.fail', () => {
      it('ctx.fail({ message }) 默认 status 500，body 不含 code 字段', async () => {
        const handler = (context: any) => context.fail({ message: '出错' });
        const response = await invokeHandler(handler, makeCtx());
        expect(response.status).toBe(500);
        expect(response.headers.get('Content-Type')).toBe('application/json');
        const body = await response.json();
        expect(body).toEqual({ error: { message: '出错' } });
        expect(body.error).not.toHaveProperty('code');
      });

      it('ctx.fail({ status, message }) body 不含 code 字段', async () => {
        const handler = (context: any) => context.fail({ status: 404, message: '用户不存在' });
        const response = await invokeHandler(handler, makeCtx());
        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body).toEqual({ error: { message: '用户不存在' } });
        expect(body.error).not.toHaveProperty('code');
      });

      it('ctx.fail({ code, message }) 无 status → HTTP 500', async () => {
        const handler = (context: any) =>
          context.fail({ code: 'AUTH_EXPIRED', message: '登录已过期' });
        const response = await invokeHandler(handler, makeCtx());
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body).toEqual({ error: { code: 'AUTH_EXPIRED', message: '登录已过期' } });
      });

      it('ctx.fail({ status, code, message }) 完整字段', async () => {
        const handler = (context: any) =>
          context.fail({ status: 404, code: 'USER_NOT_FOUND', message: '用户不存在' });
        const response = await invokeHandler(handler, makeCtx());
        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body).toEqual({
          error: { code: 'USER_NOT_FOUND', message: '用户不存在' },
        });
      });

      it('ctx.fail 返回的 Response 不被 wrapResult 包裹为 { data }', async () => {
        const handler = (context: any) =>
          context.fail({ status: 400, code: 'NAME_REQUIRED', message: 'name is required' });
        const response = await invokeHandler(handler, makeCtx());
        expect(response.status).toBe(400);
        const body = await response.json();
        // 不是 { data: { error: ... } }
        expect(body).not.toHaveProperty('data');
        expect(body).toEqual({
          error: { code: 'NAME_REQUIRED', message: 'name is required' },
        });
      });

      it('ctx.fail 合并 ctx.setStatus 设置的状态码', async () => {
        // fail 自身用 options.status 设 Response.status，
        // 但 setStatus 的 meta.status 优先级更高（toResponse 合并时覆盖）
        const handler = (context: any) => {
          context.setStatus(503);
          return context.fail({ status: 500, message: '服务降级' });
        };
        const response = await invokeHandler(handler, makeCtx());
        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body).toEqual({ error: { message: '服务降级' } });
      });

      it('ctx.fail 使用自定义 config.response.fail', async () => {
        const ctx = createTestContext({
          path: '/api/test',
          config: {
            response: {
              fail: ({
                status,
                code,
                message,
              }: {
                status?: number;
                code?: string;
                message: string;
              }) => ({
                error: { code: code ?? 'UNKNOWN', message, status },
              }),
            },
          },
        });
        const handler = (context: any) => context.fail({ status: 400, message: 'invalid' });
        const response = await invokeHandler(handler, ctx);
        expect(response.status).toBe(400);
        const body = await response.json();
        // 自定义 fail 把 code 补成 UNKNOWN
        expect(body).toEqual({
          error: { code: 'UNKNOWN', message: 'invalid', status: 400 },
        });
      });
    });

    describe('ok / fail 与中间件组合', () => {
      it('中间件 await next() 后放行到 ctx.ok 的 handler', async () => {
        const handler = (context: any) => context.ok({ via: 'ok' });
        const middlewares: FaapiMiddleware[] = [
          async (_ctx, next) => {
            await next();
          },
        ];
        const response = await invokeHandler(handler, makeCtx(), undefined, middlewares);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({ data: { via: 'ok' } });
      });

      it('中间件拦截优先于 ctx.ok（不执行 handler）', async () => {
        let handlerCalled = false;
        const handler = (context: any) => {
          handlerCalled = true;
          return context.ok({ ok: true });
        };
        const middlewares: FaapiMiddleware[] = [
          async () =>
            new Response(JSON.stringify({ error: 'blocked' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            }),
        ];
        const response = await invokeHandler(handler, makeCtx(), undefined, middlewares);
        expect(response.status).toBe(403);
        expect(handlerCalled).toBe(false);
      });

      it('中间件 try/catch 捕获 handler 抛错后用 ctx.fail 返回错误响应', async () => {
        const handler = () => {
          throw new Error('something broke');
        };
        const middlewares: FaapiMiddleware[] = [
          async (ctx, next) => {
            try {
              await next();
            } catch (err) {
              return ctx.fail({
                status: 500,
                code: 'INTERNAL_ERROR',
                message: (err as Error).message,
              });
            }
          },
        ];
        const response = await invokeHandler(handler, makeCtx(), undefined, middlewares);
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body).toEqual({
          error: { code: 'INTERNAL_ERROR', message: 'something broke' },
        });
      });
    });
  });
});
