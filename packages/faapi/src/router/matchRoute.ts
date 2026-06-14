import type { RouteManifest, RouteMatch, WsRouteManifest, WsRouteMatch } from './routeTypes';

/**
 * 根据请求路径和方法匹配路由
 * @param routes 已排序的路由清单
 * @param method HTTP 方法
 * @param path 请求路径
 * @returns 匹配结果，包含路由记录和参数
 */
export function matchRoute(routes: RouteManifest, method: string, path: string): RouteMatch | null {
  for (const route of routes) {
    // 方法不匹配，跳过
    if (route.method !== method) {
      continue;
    }

    // 静态路由直接比较
    if (!route.isDynamic) {
      if (route.urlPath === path) {
        return { route, params: {} };
      }
      continue;
    }

    // 动态路由匹配
    const params = matchDynamicPath(route.urlPath, path, route.paramNames, route.isCatchAll);
    if (params !== null) {
      return { route, params };
    }
  }

  return null;
}

/**
 * 匹配 WebSocket 路由（无 HTTP 方法维度）
 *
 * WS 路由只按路径匹配，协议升级时调用。
 * @param wsRoutes WebSocket 路由清单
 * @param path 请求路径
 */
export function matchWsRoute(wsRoutes: WsRouteManifest, path: string): WsRouteMatch | null {
  for (const route of wsRoutes) {
    // 静态路由直接比较
    if (!route.isDynamic) {
      if (route.urlPath === path) {
        return { route, params: {} };
      }
      continue;
    }

    // 动态路由匹配
    const params = matchDynamicPath(route.urlPath, path, route.paramNames, route.isCatchAll);
    if (params !== null) {
      return { route, params };
    }
  }

  return null;
}

/**
 * 动态路径匹配
 * 将路由模式（如 /user/:id）与请求路径（如 /user/123）匹配
 * 支持 catch-all 路由（如 /shop/:...slug 匹配 /shop/clothes/tops）
 * 返回提取的参数对象，不匹配返回 null
 */
export function matchDynamicPath(
  pattern: string,
  path: string,
  paramNames: string[],
  isCatchAll?: boolean,
): Record<string, string> | null {
  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = path.split('/').filter(Boolean);

  // catch-all 路由：最后一个模式段为 :...slug
  if (isCatchAll) {
    // catch-all 前面的静态/动态段必须匹配
    // catch-all 段至少匹配一个路径段
    const nonCatchAllCount = patternSegments.length - 1;
    if (pathSegments.length <= nonCatchAllCount) {
      return null;
    }

    const params: Record<string, string> = {};

    for (let i = 0; i < nonCatchAllCount; i++) {
      const patternSeg = patternSegments[i];
      const pathSeg = pathSegments[i];

      if (patternSeg.startsWith(':')) {
        const paramName = patternSeg.slice(1);
        params[paramName] = pathSeg;
      } else if (patternSeg !== pathSeg) {
        return null;
      }
    }

    // catch-all 段：剩余所有路径段用 / 连接
    const catchAllValue = pathSegments.slice(nonCatchAllCount).join('/');
    const catchAllParamName = patternSegments[nonCatchAllCount].slice(4); // 去掉 ':...'
    params[catchAllParamName] = catchAllValue;

    if (Object.keys(params).length !== paramNames.length) {
      return null;
    }

    return params;
  }

  // 普通动态路由：段数必须一致
  if (patternSegments.length !== pathSegments.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (let i = 0; i < patternSegments.length; i++) {
    const patternSeg = patternSegments[i];
    const pathSeg = pathSegments[i];

    if (patternSeg.startsWith(':')) {
      // 动态段，提取参数值
      const paramName = patternSeg.slice(1);
      params[paramName] = pathSeg;
    } else if (patternSeg !== pathSeg) {
      // 静态段不匹配
      return null;
    }
  }

  // 确保所有参数名都被提取到
  if (Object.keys(params).length !== paramNames.length) {
    return null;
  }

  return params;
}
