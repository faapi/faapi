import { describe, it, expect } from 'vitest';
import { sortRoutes } from './sortRoutes';
import type { RouteManifest } from './routeTypes';

describe('sortRoutes', () => {
  it('静态路由优先于动态路由', () => {
    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/user/:id',
        filePath: 'api/user/[id]/handler.ts',
        paramNames: ['id'],
        isDynamic: true,
      },
      {
        method: 'GET',
        urlPath: '/api/auth/login',
        filePath: 'api/auth/login/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const sorted = sortRoutes(routes);
    expect(sorted[0].urlPath).toBe('/api/auth/login');
    expect(sorted[1].urlPath).toBe('/api/user/:id');
  });

  it('路径段数少的优先', () => {
    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/a/b/c',
        filePath: 'api/a/b/c/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'GET',
        urlPath: '/api/a',
        filePath: 'api/a/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'GET',
        urlPath: '/api/a/b',
        filePath: 'api/a/b/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const sorted = sortRoutes(routes);
    expect(sorted.map((r) => r.urlPath)).toEqual(['/api/a', '/api/a/b', '/api/a/b/c']);
  });

  it('字母序排列', () => {
    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/zoo',
        filePath: 'api/zoo/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'GET',
        urlPath: '/api/alpha',
        filePath: 'api/alpha/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'GET',
        urlPath: '/api/middle',
        filePath: 'api/middle/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const sorted = sortRoutes(routes);
    expect(sorted.map((r) => r.urlPath)).toEqual(['/api/alpha', '/api/middle', '/api/zoo']);
  });

  it('综合排序：静态优先 → 段数少优先 → 字母序', () => {
    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/user/:id',
        filePath: 'api/user/[id]/handler.ts',
        paramNames: ['id'],
        isDynamic: true,
      },
      {
        method: 'GET',
        urlPath: '/api/auth/login',
        filePath: 'api/auth/login/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'GET',
        urlPath: '/api/novel/list',
        filePath: 'api/novel/list/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'GET',
        urlPath: '/api/auth',
        filePath: 'api/auth/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const sorted = sortRoutes(routes);
    expect(sorted.map((r) => r.urlPath)).toEqual([
      '/api/auth',
      '/api/auth/login',
      '/api/novel/list',
      '/api/user/:id',
    ]);
  });

  it('不修改原数组', () => {
    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/b',
        filePath: 'api/b/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'GET',
        urlPath: '/api/a',
        filePath: 'api/a/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const sorted = sortRoutes(routes);
    // 原数组不变
    expect(routes[0].urlPath).toBe('/api/b');
    expect(routes[1].urlPath).toBe('/api/a');
    // 排序后
    expect(sorted[0].urlPath).toBe('/api/a');
    expect(sorted[1].urlPath).toBe('/api/b');
  });

  it('catch-all 路由优先级最低', () => {
    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/shop/:...slug',
        filePath: 'api/shop/[...slug]/handler.ts',
        paramNames: ['slug'],
        isDynamic: true,
        isCatchAll: true,
      },
      {
        method: 'GET',
        urlPath: '/api/shop/list',
        filePath: 'api/shop/list/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'GET',
        urlPath: '/api/shop/:id',
        filePath: 'api/shop/[id]/handler.ts',
        paramNames: ['id'],
        isDynamic: true,
      },
    ];

    const sorted = sortRoutes(routes);
    expect(sorted.map((r) => r.urlPath)).toEqual([
      '/api/shop/list',
      '/api/shop/:id',
      '/api/shop/:...slug',
    ]);
  });

  it('多个 catch-all 路由按路径段数和字母序排列', () => {
    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/docs/:...slug',
        filePath: 'api/docs/[...slug]/handler.ts',
        paramNames: ['slug'],
        isDynamic: true,
        isCatchAll: true,
      },
      {
        method: 'GET',
        urlPath: '/api/blog/:...slug',
        filePath: 'api/blog/[...slug]/handler.ts',
        paramNames: ['slug'],
        isDynamic: true,
        isCatchAll: true,
      },
    ];

    const sorted = sortRoutes(routes);
    expect(sorted.map((r) => r.urlPath)).toEqual(['/api/blog/:...slug', '/api/docs/:...slug']);
  });
});
