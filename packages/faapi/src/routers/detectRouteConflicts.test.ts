import { describe, it, expect } from 'vitest';
import { detectRouteConflicts } from './detectRouteConflicts';
import type { RouteManifest } from './routeTypes';

describe('detectRouteConflicts', () => {
  it('无冲突时返回空数组', () => {
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
    ];

    const conflicts = detectRouteConflicts(routes);
    expect(conflicts).toEqual([]);
  });

  it('检测到相同 method + urlPath 的冲突', () => {
    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/auth/login',
        filePath: 'api/auth/login/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'GET',
        urlPath: '/api/auth/login',
        filePath: 'api/auth/login-alt/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const conflicts = detectRouteConflicts(routes);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].method).toBe('GET');
    expect(conflicts[0].urlPath).toBe('/api/auth/login');
    expect(conflicts[0].files).toContain('api/auth/login/handler.ts');
    expect(conflicts[0].files).toContain('api/auth/login-alt/handler.ts');
  });

  it('不同方法不冲突', () => {
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
    ];

    const conflicts = detectRouteConflicts(routes);
    expect(conflicts).toEqual([]);
  });

  it('多组冲突都能检测到', () => {
    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/a',
        filePath: 'api/a/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'GET',
        urlPath: '/api/a',
        filePath: 'api/a-dup/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'POST',
        urlPath: '/api/b',
        filePath: 'api/b/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'POST',
        urlPath: '/api/b',
        filePath: 'api/b-dup/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const conflicts = detectRouteConflicts(routes);
    expect(conflicts).toHaveLength(2);
  });

  it('空路由清单返回空数组', () => {
    const conflicts = detectRouteConflicts([]);
    expect(conflicts).toEqual([]);
  });
});
