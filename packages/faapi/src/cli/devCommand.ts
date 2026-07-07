import path from 'node:path';
import { compileDevRoutes } from './compileDevRoutes';
import { compileConfig } from './compileConfig';
import { generateSchemaFiles } from './generateSchemaFiles';
import { serializeRoutes, writeRoutesModule } from './generateRoutes';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { loadConfig } from '../config/loadConfig';
import { startWatcher } from './watcher';
import { createDevApp } from './createDevApp';

/** dev 模式默认产物根目录（dev 产物输出到 <dist>/dev） */
const DEFAULT_DEV_ROOT_DIST = '.faapi';
/** 路由清单文件名 */
const ROUTES_FILE = 'faapi-routes.js';
/** 路由源码目录（写死为 src，路由 .ts 文件位于 src/api/ 下） */
const PATTERNS = ['src/api/**/*.ts'];

/** dev 命令选项（来自 CLI 参数） */
export interface DevCommandOptions {
  port?: number;
  /** 产物根目录（默认 .faapi，实际产物输出到 <dist>/dev） */
  dist?: string;
}

/**
 * `faapi dev` 命令：编译 TypeScript → 生成产物三元组 → 启动 dev 应用 → 启动 watcher
 *
 * 与 `faapi build`（产线构建）为两套独立代码，仅共享工具级函数（compileDevRoutes/compileConfig 等）。
 *
 * dev 模式直接调用 `createDevApp()` + `listen()`，持有 app 引用后传给 watcher。
 * prod 模式由 `node <dist>/build/main`（运行 `faapi build` 生成的启动入口）调用 `createProdApp()` + `listen()`，与 dev 完全分离。
 *
 * 框架元信息通过 CLI 选项或环境变量传入（不放在 faapi.config.ts 内）：
 * - `--port` / `PORT`：服务端口，默认 3000
 * - `--dist`：产物根目录，默认 '.faapi'；dev 实际产物输出到 `<dist>/dev`
 * - `FAAPI_DIST`：dev 模式由 devCommand 设为 `<dist>/dev`
 *
 * 产物三元组（与 `faapi build` 一致，仅子目录不同：dev 用 `dev/`，build 用 `build/`）：
 * 1. `<dist>/dev/` 下所有 `.js` — 路由/middleware 编译产物（esbuild 逐文件）
 * 2. `<dist>/dev/faapi-config.js` — 配置合并产物（compileConfig 生成）
 * 3. `<dist>/dev/faapi-routes.js` — 路由清单（serializeRoutes 生成）
 * 4. `<dist>/dev/` 下各 handler 目录的 `zod.js` — schema 模块（generateSchemaFiles 生成）
 *
 * 流程：
 * 1. 设置 dev 环境标记 + `FAAPI_DIST=<dist>/dev`
 * 2. 编译配置产物 → 编译 .ts → `<dist>/dev/`
 * 3. 生成路由清单 + schema 文件
 * 4. 调用 createDevApp() + listen() 启动 dev 应用（含 reloadRoutes 热替换能力）
 * 5. 启动 watcher（增量编译 + 重生成产物 + app.reloadRoutes 热替换）
 */
export async function devCommand(options?: DevCommandOptions): Promise<void> {
  const rootDir = process.cwd();

  // 1. 设置 dev 环境标记 + dist（根目录 → 实际产物目录 <root>/dev）
  const rootDist = options?.dist ?? DEFAULT_DEV_ROOT_DIST;
  const devDist = path.join(rootDist, 'dev');
  process.env.FAAPI_DIST = devDist;
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';
  console.log('- Development mode');

  // 2. 编译配置产物
  console.log('- Compiling config...');
  await compileConfig({ rootDir, dist: devDist });
  const _config = await loadConfig(rootDir, devDist);

  // 3. 编译 .ts → <dist>/dev/
  console.log('- Compiling TypeScript...');
  await compileDevRoutes({ rootDir, dist: devDist });

  // 4. 生成路由清单 + schema 文件
  console.log('- Generating route manifest and schema...');
  await generateRouteArtifacts(rootDir, PATTERNS, devDist);

  // 5. 启动 dev 应用（createDevApp + listen，含 reloadRoutes 热替换能力）
  console.log('- Starting dev app...');
  const app = await createDevApp({ rootDir, port: options?.port });
  await app.listen();

  // 6. 启动 watcher（文件变化时增量编译 + 重生成 config + 调 app.reloadRoutes）
  startWatcher({ rootDir, app, devDist });
}

/**
 * 生成路由产物：faapi-routes.js + zod.js
 *
 * 与 `faapi build` 的步骤 4/6/7 一致，只是 dist 为 `<rootDist>/dev`。
 * watcher 触发时也调此函数重生成。
 */
export async function generateRouteArtifacts(
  rootDir: string,
  patterns: string[],
  dist: string,
): Promise<void> {
  // 扫描路由（扫描源码 .ts 文件列表，但 import 产物 .js 拿方法名）
  const { routes, wsRoutes } = await scanRoutes(rootDir, patterns, dist);
  const sorted = sortRoutes(routes);

  // 生成路由清单
  const routesPath = path.resolve(rootDir, dist, ROUTES_FILE);
  const serialized = serializeRoutes(sorted, wsRoutes, rootDir, dist);
  await writeRoutesModule(serialized, routesPath);

  // 生成 schema 文件（每个 handler 一个 zod.js）
  await generateSchemaFiles(sorted, rootDir, dist);
}
