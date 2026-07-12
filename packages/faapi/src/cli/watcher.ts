import chokidar from 'chokidar';
import path from 'node:path';
import { compileDevRoutes } from './compileDevRoutes';
import { compileConfig } from './compileConfig';
import type { DevApp } from './createDevApp';

export interface WatchOptions {
  /** 项目根目录 */
  rootDir: string;
  /** dev 应用实例（调用 app.reloadRoutes 热替换） */
  app: DevApp;
  /** dev 产物目录（如 .faapi），用于增量编译与配置重生成 */
  devDist: string;
}

/**
 * 启动文件 watcher（仅 dev 模式）
 *
 * 监听源码 `.ts` 变化，增量编译 + 重生成 config/schema 产物 + 调 `app.reloadRoutes()` 热替换。
 *
 * 与 `app.reloadRoutes()` 的分工：
 * - watcher：增量编译变化文件 + 重生成 `faapi-config.js`（如配置源码变化）
 * - `reloadRoutes()`：重新扫描路由 + 重新生成 schema + 清缓存 + 更新 server 路由引用
 *
 * 注意：`faapi-routes.js` 不在 watcher 中重生成——reloadRoutes 直接调 scanRoutes 重新扫描，
 * 不依赖重新 import faapi-routes.js（ESM 模块缓存难以可靠绕过）。
 *
 * chokidar v4 移除了 glob 模式支持，改为监听整个 `src` 目录 + `ignored` 函数过滤。
 * 监听整个 src 比 glob 更合理：handler.ts 引用的 util.ts 变化也能触发重建。
 *
 * 重建流程（debounce 100ms）：
 * 1. 增量编译变化的文件（add/change 事件累积的文件）
 * 2. 重生成 `faapi-config.js`（compileConfig 内部按文件存在性跳过编译）
 * 3. 调 `app.reloadRoutes()`（scanRoutes + generateSchemaFiles + 更新引用）
 *
 * unlink（文件删除）不增量编译（无文件可编译），但触发 reloadRoutes（路由结构变化）。
 */
export function startWatcher(options: WatchOptions): void {
  const { rootDir, app, devDist } = options;

  // 重建定时器（debounce）
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  // 累积变化的文件（绝对路径），用于增量编译
  let pendingFiles: Set<string> = new Set();

  async function rebuildRoutes(): Promise<void> {
    try {
      // 1. 增量编译变化的文件（add/change 事件累积的文件）
      const filesToCompile = Array.from(pendingFiles);
      pendingFiles = new Set();
      if (filesToCompile.length > 0) {
        await compileDevRoutes({
          rootDir,
          dist: devDist,
          files: filesToCompile,
        });
      }

      // 2. 重生成 faapi-config.js（如配置源码变化）
      //    compileConfig 内部按源文件存在性决定是否生成，无配置则跳过
      await compileConfig({ rootDir, dist: devDist });

      // 3. 调 app.reloadRoutes()（scanRoutes + generateSchemaFiles + 清缓存 + 更新引用）
      await app.reloadRoutes();

      const recompiledCount = filesToCompile.length;
      console.log(
        `- Routes rebuilt${recompiledCount > 0 ? `, ${recompiledCount} file(s) recompiled` : ''}`,
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
  // chokidar v4 移除了 glob 模式支持，改为监听 src 整个目录 + ignored 函数过滤
  // 监听整个 src 比 glob 更合理：handler.ts 引用的 util.ts 变化也能触发重建
  // 同时监听根目录的 faapi.config.{ts,js}（配置变化时重生成 faapi-config.js）
  const CONFIG_FILES = ['faapi.config.ts', 'faapi.config.js'];
  const watchPaths = ['src', ...CONFIG_FILES];
  const watcher = chokidar.watch(watchPaths, {
    cwd: rootDir,
    ignoreInitial: true,
    ignored: (filePath, stats) => {
      // 忽略非源码目录（.faapi 为默认产物根目录，devDist 为 dev 产物目录）
      if (
        filePath.includes('node_modules') ||
        filePath.includes('.faapi') ||
        filePath.includes(devDist) ||
        filePath.includes('.git')
      ) {
        return true;
      }
      // 无 stats 时不忽略（chokidar 会再次调用并传入 stats）
      if (!stats) return false;
      // 目录不忽略（chokidar 需要递归进入子目录）
      if (stats.isDirectory()) return false;
      // 只监听 .ts/.js 文件（.js 用于 faapi.config.js）
      return !filePath.endsWith('.ts') && !filePath.endsWith('.js');
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
    // 文件删除：不增量编译（无文件可编译），但触发重生成产物 + reloadRoutes（路由结构变化）
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
