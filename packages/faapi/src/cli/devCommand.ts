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

/** dev 模式产物目录 */
const DEV_OUT_DIR = '.faapi/dev';
/** 路由清单文件名 */
const ROUTES_FILE = 'faapi-routes.js';

/**
 * `faapi dev` 命令：编译 TypeScript → 生成产物三元组 → 启动 dev 应用 → 启动 watcher
 *
 * 与 `faapi build`（产线构建）为两套独立代码，仅共享工具级函数（compileDevRoutes/compileConfig 等）。
 *
 * dev 模式直接调用 `createDevApp()` + `listen()`，持有 app 引用后传给 watcher。
 * prod 模式由 `node dist/main`（运行 `faapi build` 生成的启动入口）调用 `createProdApp()` + `listen()`，与 dev 完全分离。
 *
 * 框架元信息通过环境变量传入（不放在 faapi.config.ts 内）：
 * - `FAAPI_APP_DIR`：源码目录前缀，默认 'src'
 * - `PORT`：服务端口，默认 3000
 * - `FAAPI_OUT_DIR`：dev 模式固定为 `.faapi/dev`
 *
 * 产物三元组（与 `faapi build` 一致）：
 * 1. `.faapi/dev/` 下所有 `.js` — 路由/middleware 编译产物（esbuild 逐文件）
 * 2. `.faapi/dev/faapi-config.js` — 配置合并产物（compileConfig 生成）
 * 3. `.faapi/dev/faapi-routes.js` — 路由清单（serializeRoutes 生成）
 * 4. `.faapi/dev/` 下各 handler 目录的 `zod.js` — schema 模块（generateSchemaFiles 生成）
 *
 * 流程：
 * 1. 设置 dev 环境标记 + `FAAPI_OUT_DIR`
 * 2. 编译配置产物 → 读环境变量拿 appDir → 编译 .ts → .faapi/dev/
 * 3. 生成路由清单 + schema 文件
 * 4. 调用 createDevApp() + listen() 启动 dev 应用（含 reloadRoutes 热替换能力）
 * 5. 启动 watcher（增量编译 + 重生成产物 + app.reloadRoutes 热替换）
 */
export async function devCommand(): Promise<void> {
  const rootDir = process.cwd();

  // 1. 设置 dev 环境标记 + outDir
  process.env.FAAPI_OUT_DIR = DEV_OUT_DIR;
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';
  console.log('- Development mode');

  // 2. 编译配置产物 + 读环境变量拿 appDir
  console.log('- Compiling config...');
  await compileConfig({ rootDir, outDir: DEV_OUT_DIR });
  const _config = await loadConfig(rootDir, DEV_OUT_DIR);
  const appDir = process.env.FAAPI_APP_DIR ?? 'src';
  const patterns = appDir === '.' ? ['api/**/*.ts'] : [`${appDir}/api/**/*.ts`];

  // 3. 编译 .ts → .faapi/dev/
  console.log('- Compiling TypeScript...');
  await compileDevRoutes({ rootDir, appDir, outDir: DEV_OUT_DIR });

  // 4. 生成路由清单 + schema 文件
  console.log('- Generating route manifest and schema...');
  await generateRouteArtifacts(rootDir, appDir, patterns);

  // 5. 启动 dev 应用（createDevApp + listen，含 reloadRoutes 热替换能力）
  console.log('- Starting dev app...');
  const app = await createDevApp({ rootDir });
  await app.listen();

  // 6. 启动 watcher（文件变化时增量编译 + 重生成 config + 调 app.reloadRoutes）
  startWatcher({ rootDir, appDir, app });
}

/**
 * 生成路由产物：faapi-routes.js + zod.js
 *
 * 与 `faapi build` 的步骤 4/6/7 一致，只是 outDir 为 `.faapi/dev`。
 * watcher 触发时也调此函数重生成。
 */
export async function generateRouteArtifacts(
  rootDir: string,
  appDir: string,
  patterns: string[],
): Promise<void> {
  // 扫描路由（扫描源码 .ts 文件列表，但 import 产物 .js 拿方法名）
  const { routes, wsRoutes } = await scanRoutes(rootDir, patterns, appDir, DEV_OUT_DIR);
  const sorted = sortRoutes(routes);

  // 生成路由清单
  const routesPath = path.resolve(rootDir, DEV_OUT_DIR, ROUTES_FILE);
  const serialized = serializeRoutes(sorted, wsRoutes, rootDir, appDir, DEV_OUT_DIR);
  await writeRoutesModule(serialized, routesPath);

  // 生成 schema 文件（每个 handler 一个 zod.js）
  await generateSchemaFiles(sorted, rootDir, appDir, DEV_OUT_DIR);
}
