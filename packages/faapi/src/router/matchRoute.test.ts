import { describe, it, expect } from 'vitest';
import { matchRoute, matchWsRoute } from './matchRoute';
import type { RouteManifest, WsRouteManifest } from './routeTypes';

// 模拟已排序的路由清单
const routes: RouteManifest = [
  {
    method: 'GET',
    urlPath: '/api/auth/login',
    filePath: 'api/auth/login/handler.ts',
    paramNames: [],
    isDynamic: false,
  },
  {
    method: 'POST',
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
    urlPath: '/api/user/:id',
    filePath: 'api/user/[id]/handler.ts',
    paramNames: ['id'],
    isDynamic: true,
  },
];

describe('matchRoute', () => {
  it('GET /auth/login 匹配到静态路由', () => {
    const result = matchRoute(routes, 'GET', '/api/auth/login');
    expect(result).not.toBeNull();
    expect(result!.route.urlPath).toBe('/api/auth/login');
    expect(result!.route.method).toBe('GET');
    expect(result!.params).toEqual({});
  });

  it('POST /auth/login 匹配到 POST 路由', () => {
    const result = matchRoute(routes, 'POST', '/api/auth/login');
    expect(result).not.toBeNull();
    expect(result!.route.method).toBe('POST');
    expect(result!.params).toEqual({});
  });

  it('GET /user/123 匹配到动态路由，params 为 { id: "123" }', () => {
    const result = matchRoute(routes, 'GET', '/api/user/123');
    expect(result).not.toBeNull();
    expect(result!.route.urlPath).toBe('/api/user/:id');
    expect(result!.params).toEqual({ id: '123' });
  });

  it('GET /unknown 返回 null', () => {
    const result = matchRoute(routes, 'GET', '/api/unknown');
    expect(result).toBeNull();
  });

  it('不匹配的方法返回 null', () => {
    const result = matchRoute(routes, 'DELETE', '/api/auth/login');
    expect(result).toBeNull();
  });

  it('静态路由优先于动态路由', () => {
    // 构造一个同时有静态和动态路由的场景
    const mixedRoutes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/user/me',
        filePath: 'api/user/me/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'GET',
        urlPath: '/api/user/:id',
        filePath: 'api/user/[id]/handler.ts',
        paramNames: ['id'],
        isDynamic: true,
      },
    ];

    // /user/me 应该匹配静态路由
    const result = matchRoute(mixedRoutes, 'GET', '/api/user/me');
    expect(result).not.toBeNull();
    expect(result!.route.urlPath).toBe('/api/user/me');
    expect(result!.params).toEqual({});

    // /user/other 应该匹配动态路由
    const result2 = matchRoute(mixedRoutes, 'GET', '/api/user/other');
    expect(result2).not.toBeNull();
    expect(result2!.route.urlPath).toBe('/api/user/:id');
    expect(result2!.params).toEqual({ id: 'other' });
  });

  it('动态路由段数不匹配返回 null', () => {
    const result = matchRoute(routes, 'GET', '/api/user/123/profile');
    expect(result).toBeNull();
  });

  it('catch-all 路由匹配多级路径段', () => {
    const catchAllRoutes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/shop/:...slug',
        filePath: 'api/shop/[...slug]/handler.ts',
        paramNames: ['slug'],
        isDynamic: true,
        isCatchAll: true,
      },
    ];

    // 匹配多级路径
    const result = matchRoute(catchAllRoutes, 'GET', '/api/shop/clothes/tops/t-shirt');
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ slug: 'clothes/tops/t-shirt' });

    // 匹配单级路径
    const result2 = matchRoute(catchAllRoutes, 'GET', '/api/shop/clothes');
    expect(result2).not.toBeNull();
    expect(result2!.params).toEqual({ slug: 'clothes' });

    // 至少匹配一个段
    const result3 = matchRoute(catchAllRoutes, 'GET', '/api/shop');
    expect(result3).toBeNull();
  });

  it('catch-all 路由与静态路由共存时静态优先', () => {
    const mixedRoutes: RouteManifest = [
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
      {
        method: 'GET',
        urlPath: '/api/shop/:...slug',
        filePath: 'api/shop/[...slug]/handler.ts',
        paramNames: ['slug'],
        isDynamic: true,
        isCatchAll: true,
      },
    ];

    // 静态路由优先
    const result1 = matchRoute(mixedRoutes, 'GET', '/api/shop/list');
    expect(result1).not.toBeNull();
    expect(result1!.route.urlPath).toBe('/api/shop/list');

    // 动态路由次之
    const result2 = matchRoute(mixedRoutes, 'GET', '/api/shop/123');
    expect(result2).not.toBeNull();
    expect(result2!.route.urlPath).toBe('/api/shop/:id');

    // catch-all 兜底
    const result3 = matchRoute(mixedRoutes, 'GET', '/api/shop/clothes/tops');
    expect(result3).not.toBeNull();
    expect(result3!.route.urlPath).toBe('/api/shop/:...slug');
    expect(result3!.params).toEqual({ slug: 'clothes/tops' });
  });

  it('catch-all 路由前面有动态段', () => {
    const catchAllRoutes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/blog/:id/:...slug',
        filePath: 'api/blog/[id]/[...slug]/handler.ts',
        paramNames: ['id', 'slug'],
        isDynamic: true,
        isCatchAll: true,
      },
    ];

    const result = matchRoute(catchAllRoutes, 'GET', '/api/blog/123/comments/456');
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ id: '123', slug: 'comments/456' });
  });
});

describe('matchWsRoute', () => {
  const wsRoutes: WsRouteManifest = [
    {
      urlPath: '/api/chat',
      filePath: 'api/chat/handler.ts',
      paramNames: [],
      isDynamic: false,
    },
    {
      urlPath: '/api/room/:id',
      filePath: 'api/room/[id]/handler.ts',
      paramNames: ['id'],
      isDynamic: true,
    },
  ];

  it('静态 WS 路由精确匹配', () => {
    const result = matchWsRoute(wsRoutes, '/api/chat');
    expect(result).not.toBeNull();
    expect(result!.route.urlPath).toBe('/api/chat');
    expect(result!.params).toEqual({});
  });

  it('动态 WS 路由匹配并提取参数', () => {
    const result = matchWsRoute(wsRoutes, '/api/room/123');
    expect(result).not.toBeNull();
    expect(result!.route.urlPath).toBe('/api/room/:id');
    expect(result!.params).toEqual({ id: '123' });
  });

  it('未匹配路径返回 null', () => {
    expect(matchWsRoute(wsRoutes, '/api/notfound')).toBeNull();
  });

  it('动态路由段数不匹配返回 null', () => {
    expect(matchWsRoute(wsRoutes, '/api/room/123/profile')).toBeNull();
  });

  it('静态路由优先于动态路由', () => {
    const mixed: WsRouteManifest = [
      { urlPath: '/api/ws', filePath: 'a', paramNames: [], isDynamic: false },
      { urlPath: '/api/:name', filePath: 'b', paramNames: ['name'], isDynamic: true },
    ];
    const result = matchWsRoute(mixed, '/api/ws');
    expect(result!.route.urlPath).toBe('/api/ws');
  });

  it('catch-all WS 路由匹配多级路径', () => {
    const catchAll: WsRouteManifest = [
      {
        urlPath: '/api/stream/:...slug',
        filePath: 'api/stream/[...slug]/handler.ts',
        paramNames: ['slug'],
        isDynamic: true,
        isCatchAll: true,
      },
    ];
    const result = matchWsRoute(catchAll, '/api/stream/a/b/c');
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ slug: 'a/b/c' });
  });
});
