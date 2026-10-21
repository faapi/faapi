import type { RouteManifest } from './routeTypes';

/**
 * 路由排序规则：
 * 1. 静态路由优先于动态路由
 * 2. 动态路由优先于 catch-all 路由
 * 3. 路径段数少的优先
 * 4. 字母序排列
 */
export function sortRoutes(routes: RouteManifest): RouteManifest {
  return [...routes].sort((a, b) => {
    // 1. 静态路由优先于动态路由
    if (a.isDynamic !== b.isDynamic) {
      return a.isDynamic ? 1 : -1;
    }

    // 2. catch-all 路由优先级最低（排在所有动态路由之后）
    if (a.isCatchAll !== b.isCatchAll) {
      return a.isCatchAll ? 1 : -1;
    }

    // 3. 路径段数少的优先
    const aSegments = a.urlPath.split('/').filter(Boolean).length;
    const bSegments = b.urlPath.split('/').filter(Boolean).length;
    if (aSegments !== bSegments) {
      return aSegments - bSegments;
    }

    // 4. 字母序排列
    return a.urlPath.localeCompare(b.urlPath);
  });
}
