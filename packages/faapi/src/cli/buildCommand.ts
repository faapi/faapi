import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { detectRouteConflicts } from '../router/detectRouteConflicts';
import { generateTypes } from './generateTypes';
import { writeSchemaModule } from './generateSchema';
import { collectRouteSchemaSources } from './collectRouteSchemaSources';
import type { SchemaModuleEntry } from '../ast/generateValidatorCode';
import type { HandlerTypeInfo } from '../ast/extractHandlerTypes';
import type { RouteManifest } from '../router/routeTypes';
import path from 'node:path';
import fs from 'node:fs';
import fg from 'fast-glob';

/**
 * 构建命令选项
 */
export interface BuildOptions {
  rootDir: string; // 项目根目录
  patterns: string[]; // 路由模式
  appDir: string; // app 目录
  outdir: string; // 输出目录
  types?: string; // 类型文件输出路径
}

/**
 * 执行构建命令
 *
 * faapi 是文件路由模式，无统一入口。build 命令逐个编译路由文件（保持目录结构），
 * 而非 bundle 成单文件，确保运行时动态 import 路径仍然有效。
 */
export async function buildCommand(options: BuildOptions): Promise<void> {
  const { rootDir, patterns, appDir, outdir, types } = options;

  console.log('faapi build started');
  console.log(`- Root: ${rootDir}`);
  console.log(`- Patterns: ${patterns.join(', ')}`);
  console.log(`- Output: ${outdir}`);

  // 1. 扫描路由
  console.log('\n[1/4] Scanning routes...');
  const { routes } = await scanRoutes(rootDir, patterns, appDir);
  const sorted = sortRoutes(routes);
  console.log(`  Found ${sorted.length} routes`);

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

  // 2. 生成类型文件
  console.log('\n[2/4] Generating types...');
  const typesPath = types ? path.resolve(rootDir, types) : path.resolve(rootDir, 'faapi-types.ts');
  await generateTypes(sorted, rootDir, typesPath);
  console.log(`  Written to ${typesPath}`);

  // 3. 生成 schema 模块（prd 运行时类型校验的数据来源）
  console.log('\n[3/4] Generating schema module...');
  const schemaPath = path.resolve(rootDir, outdir, 'faapi-schema.js');
  const { entries, allTypesByFile } = extractSchemaEntries(sorted, rootDir);
  await writeSchemaModule(entries, allTypesByFile, schemaPath);
  console.log(`  Written to ${schemaPath}`);

  // 4. 编译 TypeScript（逐文件编译，保持目录结构）
  console.log('\n[4/4] Compiling TypeScript...');
  await compileTypeScript(rootDir, patterns, appDir, outdir);
  console.log('  Done');

  console.log('\nfaapi build completed');
}

/**
 * 编译 TypeScript 文件
 *
 * 使用 esbuild 逐文件编译（不 bundle），保持目录结构，
 * 这样运行时动态 import 的文件路径在编译后仍然有效。
 */
async function compileTypeScript(
  rootDir: string,
  patterns: string[],
  appDir: string,
  outdir: string,
): Promise<void> {
  const esbuild = await import('esbuild');

  // 收集所有需要编译的 .ts 文件（路由文件 + 中间件文件）
  const allPatterns = [...patterns, `${appDir}/**/middlewares.ts`];
  const files = await fg(allPatterns, {
    cwd: rootDir,
    onlyFiles: true,
    absolute: true,
  });

  if (files.length === 0) {
    console.log('  No TypeScript files to compile');
    return;
  }

  // 确保输出目录存在
  const absOutdir = path.resolve(rootDir, outdir);
  await fs.promises.mkdir(absOutdir, { recursive: true });

  // 逐文件编译，保持目录结构（outbase 保证相对路径）
  await esbuild.build({
    entryPoints: files,
    outdir: absOutdir,
    outbase: rootDir,
    bundle: false, // 不 bundle，逐文件编译
    platform: 'node',
    format: 'esm',
    sourcemap: true,
    packages: 'external', // 依赖保持外部引用
    logLevel: 'info',
  });
}

/**
 * 从路由清单提取 schema entries 和 allTypesByFile
 *
 * 用于 build 时生成 schema JS 模块。
 */
function extractSchemaEntries(
  routes: RouteManifest,
  rootDir: string,
): {
  entries: SchemaModuleEntry[];
  allTypesByFile: Map<string, Map<string, HandlerTypeInfo>>;
} {
  const { sources, allTypesByFile } = collectRouteSchemaSources(routes, rootDir);
  const entries: SchemaModuleEntry[] = sources.map(({ filePath, schemaName, typeInfo }) => ({
    filePath,
    schemaName,
    typeInfo,
  }));
  return { entries, allTypesByFile };
}

/**
 * 解析构建命令参数
 */
export function parseBuildArgs(argv: string[]): BuildOptions {
  const rootDir = process.cwd();
  let outdir = 'dist';
  let appDir = '.';
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

  return { rootDir, patterns, appDir, outdir, types };
}
