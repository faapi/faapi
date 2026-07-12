import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { detectRouteConflicts } from '../router/detectRouteConflicts';
import { generateSchemaFiles } from './generateSchemaFiles';
import { serializeRoutes, writeRoutesModule } from './generateRoutes';
import { compileBuildRoutes } from './compileBuildRoutes';
import { compileConfig } from './compileConfig';
import { loadConfig } from '../config/loadConfig';
import path from 'node:path';
import fs from 'node:fs';

/** build 模式默认产物目录 */
const DEFAULT_DIST = 'dist';
/** 路由源码目录（写死为 src，路由 .ts 文件位于 src/api/ 下） */
const PATTERNS = ['src/api/**/*.ts'];

/**
 * 构建命令选项
 */
export interface BuildOptions {
  /** 项目根目录，默认 process.cwd() */
  rootDir?: string;
  /** 产物输出目录，默认 dist */
  dist?: string;
}

/**
 * 执行构建命令
 *
 * `--dist` 直接作为产物输出目录（默认 `dist`），与 Next.js `distDir` 语义一致。
 * 运行时只加载 .js 产物，不依赖 tsx。
 *
 * 应用行为配置从 faapi.config.ts 读取。
 *
 * 框架采用零入口设计——用户无需编写 main.ts，build 阶段自动生成 `<dist>/main.js` 启动入口，
 * 运行时 `node <dist>/main` 直接启动服务，无需 `faapi start` 命令。
 *
 * 端口不通过 build 选项指定——`main.js` 中 `listen()` 无参，运行时由 `PORT` 环境变量
 * 或默认值 3000 决定（与 `next build` 不支持 `--port` 的设计一致）。
 *
 * 流程：
 * 0. 编译配置产物（compileConfig）→ loadConfig 读应用行为配置
 * 1. 编译 TypeScript（逐文件编译，与 dev 一致，打平 src/ 前缀）
 * 2. 重新编译配置文件（确保使用最新源码）
 * 3. 扫描路由（从 <dist> 产物，import .js 拿方法名）
 * 4. 生成 schema 模块（AST 从源码 .ts）
 * 5. 生成路由清单
 * 6. 生成启动入口 <dist>/main.js（import createProdApp + loadEnv + listen）
 *
 * **统一编译模式**：build 与 dev 都采用 `bundle: false` 逐文件编译，差异仅由 `dist` 驱动，
 * 不存在 `if (isDev)` 控制流分支。逐文件编译保证每个源文件对应唯一一份产物，
 * config 和 routes 共享同一运行时对象（`instanceof` 跨边界生效）。
 */
export async function buildCommand(options?: BuildOptions): Promise<void> {
  const rootDir = options?.rootDir ?? process.cwd();
  const outdir = options?.dist ?? DEFAULT_DIST;

  // 加载 config
  // build 时无产物，先 compileConfig 生成临时产物到 outdir，再用 loadConfig 读
  await compileConfig({ rootDir, dist: outdir });
  const _config = await loadConfig(rootDir, outdir);

  console.log('faapi build started');
  console.log(`- Root: ${rootDir}`);
  console.log(`- Source: src/`);
  console.log(`- Output: ${outdir}`);

  // 1. 编译 TypeScript（逐文件编译，与 dev 一致）
  console.log('\n[1/6] Compiling TypeScript (bundle: false)...');
  const result = await compileBuildRoutes({
    rootDir,
    dist: outdir,
    logLevel: 'silent',
  });
  console.log(`  Compiled ${result.compiledFiles.length} file(s)`);
  if (result.compiledFiles.length === 0) {
    console.warn('  ! No source files found, nothing to build');
    return;
  }

  // 2. 编译配置文件（faapi.config.ts → <dist>/faapi-config.js）
  //    重新编译以确保使用最新源码（步骤 0 的编译是为了读 config）
  console.log('\n[2/6] Compiling config...');
  const configResult = await compileConfig({ rootDir, dist: outdir });
  if (configResult.generated) {
    console.log(`  Written to ${configResult.outputFile}`);
  } else {
    console.log('  No config file found, skipped');
  }

  // 3. 扫描路由（扫描源码 .ts 文件列表，但 import 产物 .js 拿方法名）
  console.log('\n[3/6] Scanning routes...');
  const { routes, wsRoutes } = await scanRoutes(rootDir, PATTERNS, outdir);
  const sorted = sortRoutes(routes);
  console.log(`  Found ${sorted.length} routes, ${wsRoutes.length} WS routes`);

  // 检测路由冲突
  const conflicts = detectRouteConflicts(sorted);
  if (conflicts.length > 0) {
    console.warn('! 检测到路由冲突：');
    for (const conflict of conflicts) {
      console.warn(`  ${conflict.method} ${conflict.urlPath}`);
      for (const file of conflict.files) {
        console.warn(`    - ${file}`);
      }
    }
  }

  // 4. 生成 schema 文件
  console.log('\n[4/6] Generating schema...');
  await generateSchemaFiles(sorted, rootDir, outdir);
  console.log(`  Schema: zod.js files under ${path.resolve(rootDir, outdir)}`);

  // 5. 生成路由清单（prd 启动时直接读取，不再 scanRoutes）
  console.log('\n[5/6] Generating routes manifest...');
  const routesPath = path.resolve(rootDir, outdir, 'faapi-routes.js');
  const serialized = serializeRoutes(sorted, wsRoutes, rootDir, outdir);
  await writeRoutesModule(serialized, routesPath);
  console.log(`  Written to ${routesPath}`);

  // 6. 生成启动入口 main.js（零入口设计：用户无需编写 main.ts）
  //    内部 import @faapi/faapi 的 createProdApp + loadEnv + listen
  //    运行时 `node <dist>/main` 直接启动：loadEnv 加载 .env → createProdApp 水合产物 → listen
  //    --dist 选项写入 main.js（非默认 dist 时），端口由运行时 PORT 环境变量决定
  console.log('\n[6/6] Generating entry file...');
  const mainPath = path.resolve(rootDir, outdir, 'main.js');
  // 非默认 dist 时写入 createProdApp 参数，让 prod 启动时能定位到产物目录
  const createProdAppArgs =
    options?.dist && options.dist !== DEFAULT_DIST ? `{ dist: '${outdir}' }` : '';
  const mainContent = `// 由 faapi build 自动生成，请勿手动编辑
import { createProdApp, loadEnv } from '@faapi/faapi';

// 兜底 NODE_ENV（未显式设置时）+ 加载 .env 系列文件到 process.env
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
loadEnv(process.cwd());

const app = await createProdApp(${createProdAppArgs});
await app.listen();
`;
  await fs.promises.writeFile(mainPath, mainContent, 'utf-8');
  console.log(`  Written to ${mainPath}`);

  console.log('\nfaapi build completed');
}
