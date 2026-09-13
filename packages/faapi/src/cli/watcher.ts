import chokidar from 'chokidar';
import path from 'node:path';
import { compileDevRoutes } from './compileDevRoutes';
import { compileConfig } from './compileConfig';
import type { DevApp } from './createDevApp';
import { createRebuildScheduler } from './rebuildScheduler';

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
 * - watcher：增量编译变化文件 + 重生成 `faapi-config.js`（compileConfig 内部有 mtime 短路，无变化时跳过编译）
 * - `reloadRoutes()`：重新扫描路由 + 重新生成 schema + 清缓存 + 更新 server 路由引用
 *
 * 注意：`faapi-routes.js` 不在 watcher 中重生成——reloadRoutes 直接调 scanRoutes 重新扫描，
 * 不依赖重新 import faapi-routes.js（ESM 模块缓存难以可靠绕过）。
 *
 * chokidar v4 移除了 glob 模式支持，改为监听整个 `src` 目录 + `ignored` 函数过滤。
 * 监听整个 src 比 glob 更合理：handler.ts 引用的 util.ts 变化也能触发重建。
 *
 * 重建调度（createRebuildScheduler，debounce 100ms）：
 * 1. 增量编译变化的文件（add/change 事件累积的文件）
 * 2. 重生成 `faapi-config.js`（compileConfig 内部 mtime 短路：源文件无变化时跳过编译）
 * 3. 调 `app.reloadRoutes()`（scanRoutes + generateSchemaFiles + 更新引用）
 *
 * 重建进行中不重入：新事件只累积文件，当前轮结束后自动串行补跑（见 rebuildScheduler.md）。
 * 重建失败时待编译文件回灌，等待下次文件事件一起重编译（不主动重试）。
 *
 * unlink（文件删除）不增量编译（无文件可编译），但触发 reloadRoutes（路由结构变化）。
 */
export function startWatcher(options: WatchOptions): void {
  const { rootDir, app, devDist } = options;

  async function rebuildRoutes(files: string[]): Promise<void> {
    // 1. 增量编译变化的文件（add/change 事件累积的文件）
    if (files.length > 0) {
      await compileDevRoutes({
        rootDir,
        dist: devDist,
        files,
      });
    }

    // 2. 重生成 faapi-config.js（compileConfig 内部 mtime 短路，配置源无变化时跳过）
    await compileConfig({ rootDir, dist: devDist });

    // 3. 调 app.reloadRoutes()（scanRoutes + generateSchemaFiles + 清缓存 + 更新引用）
    await app.reloadRoutes();
    // 4. 调 app.reloadTools()（scanTools + 重生成 faapi-tools.js + 清缓存）
    //    与 reloadRoutes 分离——tool 清单独立重建，无 tool 文件时 scanTools 返回空（快速跳过）
    await app.reloadTools();
    // 5. 调 app.reloadAgents()（scanAgents + 重生成 faapi-agents.js + 清缓存）
    //    与 reloadTools 分离——agent 清单独立重建，无 agent 文件时 scanAgents 返回空（快速跳过）
    await app.reloadAgents();
    // 6. 调 app.reloadTasks()（scanTasks + 重编译任务 + 重生成 faapi-tasks.js + 清队列缓存）
    //    与 reloadAgents 分离——任务清单独立重建，无任务文件时 scanTasks 返回空（快速跳过）
    await app.reloadTasks();

    console.log(
      `- Routes rebuilt${files.length > 0 ? `, ${files.length} file(s) recompiled` : ''}`,
    );
  }

  // 重建调度器：debounce 合并 + 重入保护 + 失败回灌（见 rebuildScheduler.md）
  const scheduler = createRebuildScheduler({
    rebuild: rebuildRoutes,
    onError: (err) => {
      // esbuild 抛错带结构化 errors 数组（file/line/text/frame）——逐条输出，
      // 压扁成 err.message 会让用户只剩一句摘要找不到位置
      console.error('- Error rebuilding routes:');
      const esbuildErr = err as {
        errors?: Array<{ location?: { file?: string; line?: number }; text?: string }>;
      };
      if (Array.isArray(esbuildErr?.errors) && esbuildErr.errors.length > 0) {
        for (const e of esbuildErr.errors) {
          const loc = e.location?.file
            ? `${e.location.file}${e.location.line != null ? `:${e.location.line}` : ''}: `
            : '';
          console.error(`  ${loc}${e.text ?? 'compile error'}`);
        }
      } else {
        console.error(' ', err instanceof Error ? err.message : String(err));
      }
    },
  });

  // 监听文件变化
  // chokidar v4 移除了 glob 模式支持，改为监听 src 整个目录 + ignored 函数过滤
  // 监听整个 src 比 glob 更合理：handler.ts 引用的 util.ts 变化也能触发重建
  // 同时监听根目录的 faapi.config.{ts,js}（配置变化时重生成 faapi-config.js）
  const CONFIG_FILES = ['faapi.config.ts', 'faapi.config.js'];
  const configAbsPaths = new Set(CONFIG_FILES.map((f) => path.resolve(rootDir, f)));
  // tsconfig.json 变化影响 alias 重写与 mtime 缓存输入（compileConfig 明确把
  // tsconfig 计入缓存输入），不监听的话改 paths 后要等下一个无关文件变化才生效
  const watchPaths = ['src', 'tsconfig.json', ...CONFIG_FILES];
  const scheduleOnly = new Set([...configAbsPaths, path.resolve(rootDir, 'tsconfig.json')]);
  const watcher = chokidar.watch(watchPaths, {
    cwd: rootDir,
    ignoreInitial: true,
    ignored: (filePath, stats) => {
      // 按路径段判断，避免子串误伤（如 src/lib/node_modules-helper.ts、src/api/x.faapi.ts）
      const parts = filePath.split(/[\\/]/);
      if (
        parts.includes('node_modules') ||
        parts.includes('.git') ||
        parts.includes('.faapi') ||
        (devDist && parts.includes(devDist))
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

  // config 文件事件只触发重生成（compileConfig mtime 短路：无变化时跳过），
  // 不进增量编译——config 在 src/outbase 之外，喂给 compileDevRoutes 会让 esbuild
  // 把 `..` 段转义成 `_.._` 目录，在 .faapi 下堆积垃圾产物
  watcher.on('add', (file) => handleFileEvent(file));
  watcher.on('change', (file) => handleFileEvent(file));

  /**
   * 文件事件分流：
   * - config / tsconfig：只 schedule（compileConfig mtime 短路，无变化跳过）
   * - test/d.ts：完全跳过（build/dev 全量编译都不含它们，喂给增量编译会让
   *   测试文件的语法错误打断整轮重建）
   * - 其余源码：进增量编译
   */
  function handleFileEvent(file: string): void {
    const abs = path.resolve(rootDir, file);
    if (scheduleOnly.has(abs)) {
      scheduler.schedule();
      return;
    }
    if (/\.(test|e2e\.test)\.tsx?$/.test(abs.replace(/\\/g, '/')) || abs.endsWith('.d.ts')) {
      return;
    }
    scheduler.addFiles([abs]);
  }
  watcher.on('unlink', () => {
    // 文件删除：不增量编译（无文件可编译），但触发重生成产物 + reloadRoutes（路由结构变化）
    scheduler.schedule();
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
