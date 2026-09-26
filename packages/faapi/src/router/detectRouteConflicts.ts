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

/**
 * 输出路由冲突告警（dev/build 共用的单一实现）
 *
 * 两处调用方此前各自遍历打印且格式不一（"检测到路由冲突：" vs "路由冲突："），
 * 收敛后格式统一为 `! 路由冲突: <METHOD> <path>` + 逐文件列表。返回是否有冲突，
 * 调用方可据此追加后续逻辑。
 */
export function reportRouteConflicts(routes: RouteManifest): boolean {
  const conflicts = detectRouteConflicts(routes);
  if (conflicts.length === 0) return false;
  console.warn('! 路由冲突:');
  for (const conflict of conflicts) {
    console.warn(`  ${conflict.method} ${conflict.urlPath}`);
    for (const file of conflict.files) {
      console.warn(`    - ${file}`);
    }
  }
  return true;
}
