import type { RouteManifest, RouteMatch, WsRouteManifest, WsRouteMatch } from './routeTypes';

/**
 * 路由匹配索引——把 O(n) 线性扫描降为静态路由 O(1) 命中
 *
 * 每个请求都要做路由匹配,原实现逐条遍历清单（静态路由字符串比较、动态路由
 * split('/') 比对）,大清单下是热路径开销。索引把清单分为两部分：
 * - **静态路由**：`method|urlPath` → route 的 Map,一次查找命中
 * - **动态路由**：保持清单顺序的数组（`sortRoutes` 保证静态恒在动态之前,
 *   且同一 `(method, path)` 至多一条静态路由,静态优先查与原 first-match
 *   语义完全等价）
 *
 * 索引按**清单数组身份**缓存（WeakMap）：`reloadRoutes` / `hydrateRoutes`
 * 整体替换清单数组（`routesRef.current = newRoutes`）,旧数组被替换后索引
 * 自动失效可被 GC,无需手动清理——无生命周期侵入。
 *
 * 详见 [matchRoute.md](./matchRoute.md)。
 */

/**
 * HTTP 路由匹配索引
 */
interface HttpRoutesIndex {
  /** 静态路由：`method|urlPath` → route */
  static: Map<string, RouteManifest[number]>;
  /** 静态路径 → 方法集合（405 findAllowedMethods 反查用,免再扫静态段） */
  methodsByStaticPath: Map<string, Set<string>>;
  /** 动态路由（含 catch-all）,保持清单顺序 */
  dynamics: RouteManifest;
}

/** WS 路由匹配索引（无 HTTP 方法维度） */
interface WsRoutesIndex {
  /** 静态路由：urlPath → route */
  static: Map<string, WsRouteManifest[number]>;
  /** 动态路由（含 catch-all）,保持清单顺序 */
  dynamics: WsRouteManifest;
}

const httpIndexCache = new WeakMap<RouteManifest, HttpRoutesIndex>();
const wsIndexCache = new WeakMap<WsRouteManifest, WsRoutesIndex>();

/** 构建 HTTP 路由索引（惰性,每个清单数组只构建一次） */
function getHttpIndex(routes: RouteManifest): HttpRoutesIndex {
  let index = httpIndexCache.get(routes);
  if (index) return index;

  index = { static: new Map(), methodsByStaticPath: new Map(), dynamics: [] };
  for (const route of routes) {
    if (route.isDynamic) {
      index.dynamics.push(route);
    } else {
      index.static.set(`${route.method}|${route.urlPath}`, route);
      let methods = index.methodsByStaticPath.get(route.urlPath);
      if (!methods) {
        methods = new Set();
        index.methodsByStaticPath.set(route.urlPath, methods);
      }
      methods.add(route.method);
    }
  }

  httpIndexCache.set(routes, index);
  return index;
}

/** 构建 WS 路由索引（惰性,每个清单数组只构建一次） */
function getWsIndex(routes: WsRouteManifest): WsRoutesIndex {
  let index = wsIndexCache.get(routes);
  if (index) return index;

  index = { static: new Map(), dynamics: [] };
  for (const route of routes) {
    if (route.isDynamic) {
      index.dynamics.push(route);
    } else {
      index.static.set(route.urlPath, route);
    }
  }

  wsIndexCache.set(routes, index);
  return index;
}

/**
 * 根据请求路径和方法匹配路由
 * @param routes 已排序的路由清单
 * @param method HTTP 方法
 * @param path 请求路径
 * @returns 匹配结果，包含路由记录和参数
 */
export function matchRoute(routes: RouteManifest, method: string, path: string): RouteMatch | null {
  const index = getHttpIndex(routes);

  // 静态路由 O(1) 命中（sortRoutes 保证静态优先,等价于原遍历的首个命中）
  const staticHit = index.static.get(`${method}|${path}`);
  if (staticHit) {
    return { route: staticHit, params: {} };
  }

  // 动态路由按清单顺序匹配
  for (const route of index.dynamics) {
    if (route.method !== method) {
      continue;
    }
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
  const index = getWsIndex(wsRoutes);

  const staticHit = index.static.get(path);
  if (staticHit) {
    return { route: staticHit, params: {} };
  }

  for (const route of index.dynamics) {
    const params = matchDynamicPath(route.urlPath, path, route.paramNames, route.isCatchAll);
    if (params !== null) {
      return { route, params };
    }
  }

  return null;
}

/**
 * 查找路径的所有允许方法（用于 405 响应）
 *
 * 静态段直接查索引（O(1)）,仅动态段线性扫描——原实现对全部路由做
 * O(n) 遍历 + 静态路径比较,404/405 高频场景（扫描器、探活探测）开销显著。
 */
export function findAllowedMethods(routes: RouteManifest, path: string): string[] {
  const index = getHttpIndex(routes);
  const methods = new Set<string>();

  // 静态路由：索引直查
  const staticMethods = index.methodsByStaticPath.get(path);
  if (staticMethods) {
    for (const method of staticMethods) {
      methods.add(method);
    }
  }

  // 动态路由：线性扫描
  for (const route of index.dynamics) {
    const params = matchDynamicPath(route.urlPath, path, route.paramNames, route.isCatchAll);
    if (params !== null) {
      methods.add(route.method);
    }
  }

  return Array.from(methods);
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
      // i < nonCatchAllCount ≤ 两数组长度，索引必然存在
      const patternSeg = patternSegments[i]!;
      const pathSeg = pathSegments[i]!;

      if (patternSeg.startsWith(':')) {
        const paramName = patternSeg.slice(1);
        params[paramName] = pathSeg;
      } else if (patternSeg !== pathSeg) {
        return null;
      }
    }

    // catch-all 段：剩余所有路径段用 / 连接
    const catchAllValue = pathSegments.slice(nonCatchAllCount).join('/');
    // 前置检查 pathSegments.length > nonCatchAllCount 保证 catch-all 段存在
    const catchAllParamName = patternSegments[nonCatchAllCount]!.slice(4); // 去掉 ':...'
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
    // 段数一致性检查后索引必然存在
    const patternSeg = patternSegments[i]!;
    const pathSeg = pathSegments[i]!;

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
