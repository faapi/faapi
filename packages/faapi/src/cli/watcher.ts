import chokidar from 'chokidar';
import type { Server } from 'node:http';
import path from 'node:path';
import type { RouteManifest, WsRouteManifest } from '../router/routeTypes';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { invalidateMiddlewareCache } from '../middleware/loadMiddlewares';
import { invalidateProgramCache } from '../ast/createProgram';
import { generateSchemaFile, loadSchemaToRegistry } from './generateSchema';
import { compileRoutes } from './compileRoutes';

/** dev 模式产物目录（与 startCommand 保持一致） */
const DEV_OUT_DIR = '.faapi/dev';

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
 * 启动 watch 模式（仅 dev）
 *
 * 参考 Next.js dev 模式：监听源码 `.ts` 变化，增量编译到 `.faapi/dev/`，热替换路由。
 *
 * chokidar v4 移除了 glob 模式支持，改为监听整个 `appDir` 目录 + `ignored` 函数过滤。
 * 监听整个 appDir 比 glob 更合理：handler.ts 引用的 util.ts 变化也能触发重建。
 *
 * 重建流程（debounce 100ms）：
 * 1. 更新 `__FAAPI_LOAD_TS__`（ESM import 时拼接时间戳绕过缓存）
 * 2. 清理中间件 + Program 缓存（避免加载旧版本）
 * 3. 增量编译变化的文件（compileRoutes with files 参数，只编译 add/change 的文件）
 * 4. 全量扫描路由（import 产物 .js，filePath 保持源码 .ts）
 * 5. 重新生成 schema 文件（.faapi/dev/faapi-schema.js）
 * 6. 重新加载 schema（readManifestFile + schemaRegistry.loadManifest）
 * 7. 更新 server 路由引用（globalThis.__FAAPI_ROUTES__ / __FAAPI_WS_ROUTES__）
 *
 * 增量编译 + 全量扫描的理由：
 * - 增量编译：只编译变化的文件，速度快
 * - 全量扫描：路由结构可能变化（新增/删除 handler.ts），需要全量扫描保证一致性；
 *   scanRoutes 内部用 importWithCacheBust，已更新时间戳后会重新 import 产物
 *
 * unlink（文件删除）不增量编译（无文件可编译），但触发全量扫描，
 * scanRoutes 通过 patterns glob 自然排除已删除的文件。
 */
export function startWatcher(options: WatchOptions): void {
  const { rootDir, patterns, appDir } = options;

  // 重建定时器（debounce）
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  // 累积变化的文件（绝对路径），用于增量编译
  let pendingFiles: Set<string> = new Set();

  async function rebuildRoutes(): Promise<void> {
    try {
      // 1. 更新模块加载时间戳，ESM import 时拼接该时间戳绕过缓存
      const timestamp = Date.now();
      (globalThis as Record<string, unknown>).__FAAPI_LOAD_TS__ = timestamp;

      // 2. 清理所有缓存（中间件 + Program）
      invalidateMiddlewareCache();
      invalidateProgramCache();

      // 3. 增量编译变化的文件（add/change 事件累积的文件）
      const filesToCompile = Array.from(pendingFiles);
      pendingFiles = new Set();
      if (filesToCompile.length > 0) {
        await compileRoutes({
          rootDir,
          appDir,
          outDir: DEV_OUT_DIR,
          files: filesToCompile,
        });
      }

      // 4. 重新扫描路由（全量扫描，import 产物 .js 拿方法名）
      const { routes, wsRoutes } = await scanRoutes(rootDir, patterns, appDir, DEV_OUT_DIR);
      const sorted = sortRoutes(routes);

      // 5. 重新生成 schema 文件（AST 从源码 .ts）
      const schemaPath = path.resolve(rootDir, DEV_OUT_DIR, 'faapi-schema.js');
      await generateSchemaFile(sorted, rootDir, schemaPath);

      // 6. 重新加载 schema（dev 模式 route.filePath 是源码路径，不需要 remap）
      await loadSchemaToRegistry(schemaPath, rootDir, DEV_OUT_DIR, false);

      // 7. 更新服务器的路由引用（HTTP + WS）
      updateServerRoutes(sorted, wsRoutes);

      const recompiledCount = filesToCompile.length;
      console.log(
        `- Routes rebuilt: ${sorted.length} route(s), ${wsRoutes.length} WS route(s)${recompiledCount > 0 ? `, ${recompiledCount} file(s) recompiled` : ''}`,
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
  // chokidar v4 移除了 glob 模式支持，改为监听 appDir 整个目录 + ignored 函数过滤
  // 监听整个 appDir 比 glob 更合理：handler.ts 引用的 util.ts 变化也能触发重建
  const watcher = chokidar.watch(appDir, {
    cwd: rootDir,
    ignoreInitial: true,
    ignored: (filePath, stats) => {
      // 忽略非源码目录
      if (
        filePath.includes('node_modules') ||
        filePath.includes('.faapi') ||
        filePath.includes('dist') ||
        filePath.includes('.git')
      ) {
        return true;
      }
      // 无 stats 时不忽略（chokidar 会再次调用并传入 stats）
      if (!stats) return false;
      // 目录不忽略（chokidar 需要递归进入子目录）
      if (stats.isDirectory()) return false;
      // 只监听 .ts 文件
      return !filePath.endsWith('.ts');
    },
  });

  watcher.on('add', (file) => {
    pendingFiles.add(path.resolve(rootDir, file));
    scheduleRebuild();
  });
  watcher.on('change', (file) => {
    pendingFiles.add(path.resolve(rootDir, file));
    scheduleRebuild();
  });
  watcher.on('unlink', () => {
    // 文件删除：不增量编译（无文件可编译），但触发全量扫描（路由结构变化）
    scheduleRebuild();
  });
  watcher.on('error', (err) => {
    console.error('- Watcher error:', err instanceof Error ? err.message : String(err));
  });
  watcher.on('ready', () => {
    const watched = watcher.getWatched();
    const dirCount = Object.keys(watched).length;
    const fileCount = Object.values(watched).reduce((sum, files) => sum + files.length, 0);
    console.log(`- Watcher ready: ${dirCount} dir(s), ${fileCount} file(s) watched`);
  });

  console.log('- Watch mode enabled');
}

/**
 * 更新服务器的路由引用（HTTP + WS）
 * 通过修改全局状态实现热更新，server 内部读取该全局变量
 */
function updateServerRoutes(routes: RouteManifest, wsRoutes: WsRouteManifest): void {
  (globalThis as Record<string, unknown>).__FAAPI_ROUTES__ = routes;
  (globalThis as Record<string, unknown>).__FAAPI_WS_ROUTES__ = wsRoutes;
}
