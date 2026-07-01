import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { detectRouteConflicts } from '../router/detectRouteConflicts';
import { generateTypes } from './generateTypes';
import { generateSchemaFile } from './generateSchema';
import { serializeRoutes, writeRoutesModule } from './generateRoutes';
import { compileRoutes } from './compileRoutes';
import path from 'node:path';

/**
 * 构建命令选项
 */
export interface BuildOptions {
  rootDir: string; // 项目根目录
  patterns: string[]; // 路由模式（源码 .ts）
  appDir: string; // app 目录
  outdir: string; // 输出目录
  types?: string; // 类型文件输出路径
}

/**
 * 执行构建命令
 *
 * 参考 Next.js 实现：先编译 `.ts` 到中间产物（`dist/`），再扫描路由。
 * 运行时只加载 `.js` 产物，不依赖 tsx。
 *
 * 流程：
 * 1. 编译 TypeScript（esbuild：src 下所有 .ts → dist 下对应 .js，含别名重写）
 * 2. 扫描路由（从 dist/ 产物，import .js 拿方法名）
 * 3. 生成类型文件
 * 4. 生成 schema 模块（AST 从源码 .ts）
 * 5. 生成路由清单
 */
export async function buildCommand(options: BuildOptions): Promise<void> {
  const { rootDir, patterns, appDir, outdir, types } = options;

  console.log('faapi build started');
  console.log(`- Root: ${rootDir}`);
  console.log(`- Patterns: ${patterns.join(', ')}`);
  console.log(`- Output: ${outdir}`);

  // 1. 编译 TypeScript（src/**/*.ts → dist/**/*.js）
  console.log('\n[1/5] Compiling TypeScript...');
  const result = await compileRoutes({ rootDir, appDir, outDir: outdir, logLevel: 'silent' });
  console.log(`  Compiled ${result.compiledFiles.length} file(s)`);

  // 2. 扫描路由（扫描源码 .ts 文件列表，但 import 产物 .js 拿方法名）
  console.log('\n[2/5] Scanning routes...');
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

  // 3. 生成类型文件
  console.log('\n[3/5] Generating types...');
  const typesPath = types ? path.resolve(rootDir, types) : path.resolve(rootDir, 'faapi-types.ts');
  await generateTypes(sorted, rootDir, typesPath);
  console.log(`  Written to ${typesPath}`);

  // 4. 生成 schema 模块（prd 运行时类型校验的数据来源）
  console.log('\n[4/5] Generating schema module...');
  const schemaPath = path.resolve(rootDir, outdir, 'faapi-schema.js');
  await generateSchemaFile(sorted, rootDir, schemaPath);
  console.log(`  Written to ${schemaPath}`);

  // 5. 生成路由清单（prd 启动时直接读取，不再 scanRoutes）
  console.log('\n[5/5] Generating routes manifest...');
  const routesPath = path.resolve(rootDir, outdir, 'faapi-routes.js');
  const serialized = serializeRoutes(sorted, wsRoutes, rootDir, outdir);
  await writeRoutesModule(serialized, routesPath);
  console.log(`  Written to ${routesPath}`);

  console.log('\nfaapi build completed');
}

/**
 * 解析构建命令参数
 */
export function parseBuildArgs(argv: string[]): BuildOptions {
  const rootDir = process.cwd();
  let outdir = 'dist';
  let appDir = 'src';
  let types: string | undefined;
  const patterns: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--outdir' || arg === '-o') {
      outdir = argv[++i];
    } else if (arg === '--app-dir') {
      appDir = argv[++i];
    } else if (arg === '--types') {
      types = argv[++i];
    } else if (!arg.startsWith('-')) {
      patterns.push(arg);
    }
  }

  // 默认扫描 <appDir>/api/**/*.ts（与 parseArgs 保持一致）
  // --app-dir . 时为 api/**/*.ts
  const defaultPattern = appDir === '.' ? 'api/**/*.ts' : `${appDir}/api/**/*.ts`;

  return {
    rootDir,
    patterns: patterns.length > 0 ? patterns : [defaultPattern],
    appDir,
    outdir,
    types,
  };
}
