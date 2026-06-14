import chokidar from 'chokidar';
import type { Server } from 'node:http';
import type { RouteManifest, WsRouteManifest } from '../router/routeTypes';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { invalidateMiddlewareCache } from '../middleware/loadMiddlewares';
import { invalidateProgramCache } from '../ast/createProgram';
import { schemaRegistry } from '../validator/schemaRegistry';
import { extractSchemasForRoutes } from './generateSchema';

export interface WatchOptions {
  rootDir: string;
  patterns: string[];
  appDir: string;
  server: Server;
  port: number;
  cors?: boolean;
  staticDir?: string;
  types?: string;
}

/**
 * 启动 watch 模式
 *
 * 监听文件变化（handler.ts / middlewares.ts）：
 * - 清理所有缓存（中间件 + Program）
 * - 全量重新扫描路由 + 提取 schema
 * - 通过全局状态让 server 使用最新路由（HTTP + WS）
 *
 * 全量重建而非增量更新，理由：
 * - 简单可靠，无状态一致性问题
 * - 跨文件类型引用自然解决（全量提取时所有类型都在）
 * - dev 模式文件量有限，全量提取在百毫秒级，debounce 后用户无感
 *
 * ESM 模块缓存通过时间戳 query string 绕过。
 */
export function startWatcher(options: WatchOptions): void {
  const { rootDir, patterns, appDir } = options;

  // 重建定时器（debounce）
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  // 全量重建路由和 schema
  async function rebuildRoutes(): Promise<void> {
    try {
      // 更新模块加载时间戳，ESM import 时拼接该时间戳绕过缓存
      const timestamp = Date.now();
      (globalThis as Record<string, unknown>).__FAAPI_LOAD_TS__ = timestamp;

      // 清理所有缓存（中间件 + Program）
      invalidateMiddlewareCache();
      invalidateProgramCache();

      // 重新扫描路由（HTTP + WS）
      const { routes, wsRoutes } = await scanRoutes(rootDir, patterns, appDir);
      const sorted = sortRoutes(routes);

      // 全量提取 schema 并加载到注册表
      const manifest = extractSchemasForRoutes(sorted, rootDir);
      schemaRegistry.loadManifest(manifest);

      // 更新服务器的路由引用（HTTP + WS）
      updateServerRoutes(sorted, wsRoutes);

      const wsCount = wsRoutes.length;
      console.log(
        `- Routes rebuilt: ${sorted.length} route(s), ${wsCount} WS route(s), ${manifest.size} file(s)`,
      );
    } catch (err) {
      console.error('- Error rebuilding routes:', err instanceof Error ? err.message : String(err));
    }
  }

  // debounce 重建：编辑器保存时可能触发多次写操作
  function scheduleRebuild(): void {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      void rebuildRoutes();
    }, 100);
  }

  // 监听文件变化
  const watchPatterns = [...patterns, `${appDir}/**/middlewares.ts`];

  const watcher = chokidar.watch(watchPatterns, {
    cwd: rootDir,
    ignoreInitial: true,
    ignored: ['**/node_modules/**', '**/.faapi/**', '**/dist/**'],
  });

  watcher.on('add', () => scheduleRebuild());
  watcher.on('change', () => scheduleRebuild());
  watcher.on('unlink', () => scheduleRebuild());

  console.log('- Watch mode enabled');
}

/**
 * 更新服务器的路由引用（HTTP + WS）
 * 通过修改全局状态实现热更新
 */
function updateServerRoutes(routes: RouteManifest, wsRoutes: WsRouteManifest): void {
  (globalThis as Record<string, unknown>).__FAAPI_ROUTES__ = routes;
  (globalThis as Record<string, unknown>).__FAAPI_WS_ROUTES__ = wsRoutes;
}
