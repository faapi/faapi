import { describe, it, expect, expectTypeOf } from 'vitest';
import type { FaapiConfig, LifecycleHooks, LifecycleContext } from './configTypes';
import type { RouteManifest } from '../router/routeTypes';
import type { Server } from 'node:http';

describe('configTypes', () => {
  it('FaapiConfig 类型可正确构造(包含所有字段)', () => {
    const config: FaapiConfig = {
      port: 3000,
      cors: { origin: '*' },
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
    expect(config.cors).toBeUndefined();
    expect(config.lifecycle).toBeUndefined();
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

  it('FaapiConfig 支持自定义业务配置(任意 key)', () => {
    const config: FaapiConfig = {
      port: 3000,
      db: { host: 'localhost', port: 5432 },
      redis: { host: '127.0.0.1', port: 6379 },
    };
    expect((config as { db: { host: string } }).db.host).toBe('localhost');
  });
});
