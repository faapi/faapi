import type { RouteManifest } from './routeTypes';

export interface RouteConflict {
  method: string;
  urlPath: string;
  files: string[];
}

/**
 * 检测路由冲突（相同 method + urlPath 的多个文件）
 */
export function detectRouteConflicts(routes: RouteManifest): RouteConflict[] {
  const map = new Map<string, RouteConflict>();

  for (const route of routes) {
    const key = `${route.method} ${route.urlPath}`;
    const existing = map.get(key);
    if (existing) {
      existing.files.push(route.filePath);
    } else {
      map.set(key, {
        method: route.method,
        urlPath: route.urlPath,
        files: [route.filePath],
      });
    }
  }

  // 只返回有冲突的（文件数 > 1）
  const conflicts: RouteConflict[] = [];
  for (const conflict of map.values()) {
    if (conflict.files.length > 1) {
      conflicts.push(conflict);
    }
  }

  return conflicts;
}
