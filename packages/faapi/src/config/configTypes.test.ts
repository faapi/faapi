import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  FaapiConfig,
  ResponseFormatFn,
  ErrorFormatFn,
  LifecycleHooks,
  LifecycleContext,
} from './configTypes';
import type { FaapiContext } from '../runtime/contextTypes';
import type { RouteManifest } from '../router/routeTypes';
import type { Server } from 'node:http';

describe('configTypes', () => {
  it('FaapiConfig 类型可正确构造（包含所有字段）', () => {
    const config: FaapiConfig = {
      port: 3000,
      staticDir: 'public',
      cors: { origin: '*' },
      responseFormat: (data) => ({ code: 0, data }),
      errorFormat: (error) => new Response(JSON.stringify({ error }), { status: 500 }),
      lifecycle: {
        onReady: async () => {},
        onClose: async () => {},
      },
    };
    expect(config.port).toBe(3000);
  });

  it('FaapiConfig 的可选字段可以省略', () => {
    const config: FaapiConfig = {
      port: 3000,
    };
    expect(config.staticDir).toBeUndefined();
    expect(config.cors).toBeUndefined();
    expect(config.responseFormat).toBeUndefined();
    expect(config.errorFormat).toBeUndefined();
    expect(config.lifecycle).toBeUndefined();
  });

  it('ResponseFormatFn 类型可正确构造', () => {
    const fn: ResponseFormatFn = (data, _ctx) => {
      return { code: 0, data, timestamp: Date.now() };
    };
    expect(typeof fn).toBe('function');
  });

  it('ErrorFormatFn 类型可正确构造（返回 Response 或 null/undefined）', () => {
    const fn: ErrorFormatFn = (error, _ctx) => {
      if (error instanceof Error) {
        return new Response(JSON.stringify({ error: String(error) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // 不处理，交给框架兜底
      return null;
    };
    expect(typeof fn).toBe('function');
  });

  it('LifecycleHooks 类型可正确构造', () => {
    const hooks: LifecycleHooks = {
      onReady: async (ctx) => {
        console.log('ready', ctx.rootDir);
      },
      onClose: async (ctx) => {
        console.log('close', ctx.rootDir);
      },
    };
    expect(typeof hooks.onReady).toBe('function');
    expect(typeof hooks.onClose).toBe('function');
  });

  it('LifecycleContext 类型可正确构造', () => {
    const ctx: LifecycleContext = {
      rootDir: '/app',
      routes: [] as RouteManifest,
      server: {} as Server,
    };
    expect(ctx.rootDir).toBe('/app');
    expect(ctx.routes).toEqual([]);
  });

  it('FaapiConfig 的 responseFormat 接收 data 和 ctx 参数', () => {
    const config: FaapiConfig = {
      port: 3000,
      responseFormat: (data: unknown, ctx: FaapiContext) => {
        expectTypeOf(data).toBeUnknown();
        expectTypeOf(ctx).toMatchTypeOf<FaapiContext>();
        return { code: 0, data };
      },
    };
    expect(typeof config.responseFormat).toBe('function');
  });

  it('FaapiConfig 的 errorFormat 接收 error 参数返回 Response 或 null/undefined', () => {
    const config: FaapiConfig = {
      port: 3000,
      errorFormat: (error: unknown) => {
        expectTypeOf(error).toBeUnknown();
        // 仅处理关心的错误，其余返回 null 交给框架兜底
        if (typeof error === 'object' && error !== null) {
          return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
        }
        return null;
      },
    };
    expect(typeof config.errorFormat).toBe('function');
  });

  it('FaapiConfig 的 lifecycle.onReady 接收 LifecycleContext 参数', () => {
    const config: FaapiConfig = {
      port: 3000,
      lifecycle: {
        onReady: (ctx: LifecycleContext) => {
          expectTypeOf(ctx).toMatchTypeOf<LifecycleContext>();
          expectTypeOf(ctx.rootDir).toBeString();
          expectTypeOf(ctx.routes).toMatchTypeOf<RouteManifest>();
          expectTypeOf(ctx.server).toMatchTypeOf<Server>();
        },
      },
    };
    expect(typeof config.lifecycle!.onReady).toBe('function');
  });
});
