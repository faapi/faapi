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
import fg from 'fast-glob';

/** build 模式产物目录（固定） */
const PROD_OUT_DIR = 'dist';

/**
 * 构建命令选项
 */
export interface BuildOptions {
  /** 项目根目录，默认 process.cwd() */
  rootDir?: string;
}

/**
 * 收集 bundle 模式的入口文件（绝对路径，去重）
 *
 * entries = handler.ts + middlewares.ts
 *
 * - handler.ts：通过 patterns 扫描源码得到（与 scanRoutes 的扫描范围一致）
 * - middlewares.ts：扫描 appDir 下所有 middlewares.ts（中间件文件按目录约定自动加载，
 *   handler 不直接 import，必须作为独立 entry 才能被运行时按 middlewarePaths 动态 import）
 *
 * 框架采用零入口设计——用户无需编写 main.ts，build 阶段自动生成 `dist/main.js` 启动入口。
 *
 * 其他 .ts 文件（如 utils.ts）不需作为 entry：bundle 模式下 esbuild 会跟随 import 链自动把它们
 * bundle 进用到的 entry，或通过 splitting 提取为 chunk。
 */
async function collectBundleEntries(
  rootDir: string,
  patterns: string[],
  appDir: string,
): Promise<string[]> {
  const entries = new Set<string>();

  // 1. handler.ts：用 patterns 扫描源码（与 scanRoutes 同一范围）
  const handlerFiles = await fg(patterns, {
    cwd: rootDir,
    onlyFiles: true,
    absolute: true,
  });
  for (const f of handlerFiles) {
    if (f.endsWith('handler.ts')) entries.add(f);
  }

  // 2. middlewares.ts：扫描 appDir 下所有目录约定中间件文件
  const mwGlob = appDir === '.' ? '**/middlewares.ts' : appDir + '/**/middlewares.ts';
  const mwFiles = await fg([mwGlob], {
    cwd: rootDir,
    onlyFiles: true,
    absolute: true,
    ignore: ['**/*.test.ts', '**/*.e2e.test.ts', '**/*.d.ts'],
  });
  for (const f of mwFiles) entries.add(f);

  return Array.from(entries);
}

/**
 * 执行构建命令
 *
 * 参考 Next.js 实现：先编译 .ts 到中间产物（dist/），再扫描路由。
 * 运行时只加载 .js 产物，不依赖 tsx。
 *
 * 配置（appDir 等）从环境变量读取，应用行为配置从 faapi.config.ts 读取，不再通过 CLI 选项传入。
 * 输出目录固定为 dist（prod 模式 `node dist/main` 通过 FAAPI_OUT_DIR 默认读 dist/）。
 *
 * 框架采用零入口设计——用户无需编写 main.ts，build 阶段自动生成 `dist/main.js` 启动入口，
 * 运行时 `node dist/main` 直接启动服务，无需 `faapi start` 命令。
 *
 * 流程：
 * 0. 编译配置产物（compileConfig）→ loadConfig 读应用行为配置，环境变量读 appDir
 * 1. 收集 bundle entries
 * 2. 编译 TypeScript（bundle 模式 + splitting + define process.env.NODE_ENV → 'production'）
 * 3. 重新编译并合并配置文件（确保使用最新源码）
 * 4. 扫描路由（从 dist/ 产物，import .js 拿方法名）
 * 5. 生成 schema 模块（AST 从源码 .ts）
 * 6. 生成路由清单
 * 7. 生成启动入口 dist/main.js（import createProdApp + listen）
 *
 * bundle 模式与 dev 模式的差异（仅编译模式不同，产物三元组一致）：
 * - dev：bundle: false，逐文件编译，启动快、增量编译；compileConfig 生成 .faapi/dev/faapi-config.js
 * - build：bundle: true + splitting，跟随 import 链做 tree shaking，
 *   define + minifySyntax 编译时替换 process.env.NODE_ENV + 死分支删除；
 *   compileConfig 生成 dist/faapi-config.js，运行时零编译
 */
export async function buildCommand(options?: BuildOptions): Promise<void> {
  const rootDir = options?.rootDir ?? process.cwd();
  const outdir = PROD_OUT_DIR;

  // 加载 config + 从环境变量读 appDir
  // build 时无 dist/ 产物，先 compileConfig 生成临时产物到 outdir，再用 loadConfig 读
  await compileConfig({ rootDir, outDir: outdir });
  const _config = await loadConfig(rootDir, outdir);

  const appDir = process.env.FAAPI_APP_DIR ?? 'src';
  const patterns = appDir === '.' ? ['api/**/*.ts'] : [`${appDir}/api/**/*.ts`];

  console.log('faapi build started');
  console.log(`- Root: ${rootDir}`);
  console.log(`- AppDir: ${appDir}`);
  console.log(`- Output: ${outdir}`);

  // 1. 收集 bundle entries
  console.log('\n[1/7] Collecting bundle entries...');
  const entries = await collectBundleEntries(rootDir, patterns, appDir);
  console.log(`  ${entries.length} entry file(s)`);
  if (entries.length === 0) {
    console.warn('  ! No entry files found, nothing to build');
    return;
  }

  // 2. 编译 TypeScript（bundle 模式 + splitting + define + minifySyntax）
  console.log('\n[2/7] Compiling TypeScript (bundle mode)...');
  const result = await compileBuildRoutes({
    rootDir,
    appDir,
    outDir: outdir,
    entries,
    splitting: true,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    minifySyntax: true,
    logLevel: 'silent',
  });
  console.log(`  Compiled ${result.compiledFiles.length} entry file(s)`);

  // 3. 编译并合并配置文件（faapi.config.ts + env 配置 → dist/faapi-config.js）
  //    重新编译以确保使用最新源码（步骤 0 的编译是为了读 config，可能未含最新 env 文件）
  console.log('\n[3/7] Compiling config...');
  const configResult = await compileConfig({ rootDir, outDir: outdir });
  if (configResult.generated) {
    console.log(`  Written to ${configResult.outputFile}`);
  } else {
    console.log('  No config file found, skipped');
  }

  // 4. 扫描路由（扫描源码 .ts 文件列表，但 import 产物 .js 拿方法名）
  console.log('\n[4/7] Scanning routes...');
  const { routes, wsRoutes } = await scanRoutes(rootDir, patterns, appDir, outdir);
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

  // 5. 生成 schema 文件
  console.log('\n[5/7] Generating schema...');
  await generateSchemaFiles(sorted, rootDir, appDir, outdir);
  console.log(`  Schema: zod.js files under ${path.resolve(rootDir, outdir)}`);

  // 6. 生成路由清单（prd 启动时直接读取，不再 scanRoutes）
  console.log('\n[6/7] Generating routes manifest...');
  const routesPath = path.resolve(rootDir, outdir, 'faapi-routes.js');
  const serialized = serializeRoutes(sorted, wsRoutes, rootDir, appDir, outdir);
  await writeRoutesModule(serialized, routesPath);
  console.log(`  Written to ${routesPath}`);

  // 7. 生成启动入口 dist/main.js（零入口设计：用户无需编写 main.ts）
  //    内部 import @faapi/faapi 的 createProdApp + listen，运行时 `node dist/main` 直接启动
  console.log('\n[7/7] Generating entry file...');
  const mainPath = path.resolve(rootDir, outdir, 'main.js');
  const mainContent = `// 由 faapi build 自动生成，请勿手动编辑
import { createProdApp } from '@faapi/faapi';

const app = await createProdApp();
await app.listen();
`;
  await fs.promises.writeFile(mainPath, mainContent, 'utf-8');
  console.log(`  Written to ${mainPath}`);

  console.log('\nfaapi build completed');
}
