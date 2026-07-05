import path from 'node:path';
import fs from 'node:fs';
import fg from 'fast-glob';
import { buildAliasPlugins } from './aliasPlugin';

/**
 * dev 编译选项
 */
export interface CompileDevOptions {
  /** 项目根目录 */
  rootDir: string;
  /** app 目录前缀（如 src） */
  appDir: string;
  /** 输出目录（dev 模式为 `.faapi/dev`） */
  outDir: string;
  /**
   * 增量编译：传入要编译的文件列表（绝对路径）。
   * 不传则全量编译 appDir 下所有 .ts（排除测试文件和声明文件）。
   */
  files?: string[];
  /** 是否输出 esbuild 日志（dev 模式默认静默） */
  logLevel?: 'silent' | 'info';
}

/**
 * 编译结果
 */
export interface CompileResult {
  /** 已编译的文件列表（绝对路径） */
  compiledFiles: string[];
}

/**
 * dev 模式编译 TypeScript：逐文件编译，启动快、增量编译友好
 *
 * 每个 `.ts` 独立编译为 `.js`，不分析 import 关系（`bundle: false`）。
 * 产物**打平 appDir 前缀**：
 * - `src/api/hello/handler.ts` → `<outDir>/api/hello/handler.js`
 *
 * 别名在编译时重写为相对路径，运行时无需 loader。
 *
 * 框架采用零入口设计——用户无需编写 main.ts，dev/prod 启动由 CLI 内部编排。
 *
 * @example
 * // 全量编译
 * await compileDevRoutes({ rootDir, appDir: 'src', outDir: '.faapi/dev' });
 * // watch 增量：只编译变化的文件
 * await compileDevRoutes({ rootDir, appDir: 'src', outDir: '.faapi/dev', files: changedFiles });
 */
export async function compileDevRoutes(options: CompileDevOptions): Promise<CompileResult> {
  const { rootDir, appDir, outDir, files, logLevel = 'silent' } = options;

  // 收集要编译的文件：files 优先，否则全量扫描 appDir 下所有 .ts
  const entryPoints =
    files ??
    (await fg([`${appDir}/**/*.ts`], {
      cwd: rootDir,
      onlyFiles: true,
      absolute: true,
      ignore: ['**/*.test.ts', '**/*.e2e.test.ts', '**/*.d.ts'],
    }));

  if (entryPoints.length === 0) {
    return { compiledFiles: [] };
  }

  // 确保输出目录存在
  const absOutDir = path.resolve(rootDir, outDir);
  await fs.promises.mkdir(absOutDir, { recursive: true });

  // 构造别名重写插件（无 tsconfig/paths 时为空）
  const plugins = buildAliasPlugins(rootDir);

  // 逐文件编译，outbase 设为 appDir 以打平产物结构：
  // `src/api/hello/handler.ts` → `<outDir>/api/hello/handler.js`（去掉 src/ 前缀）
  // appDir='.' 时 outbase=rootDir，保留原结构（源码在根目录的场景）
  const esbuild = await import('esbuild');
  const outbase = appDir === '.' ? rootDir : path.resolve(rootDir, appDir);
  await esbuild.build({
    entryPoints,
    outdir: absOutDir,
    outbase,
    bundle: false,
    platform: 'node',
    format: 'esm',
    sourcemap: true,
    packages: 'external',
    plugins,
    logLevel,
  });

  return { compiledFiles: entryPoints };
}

/**
 * 扫描 appDir 下的所有 .ts 文件（排除测试文件和声明文件）
 *
 * 用于全量编译和 watch 监听。
 */
export async function collectSourceFiles(rootDir: string, appDir: string): Promise<string[]> {
  return fg([`${appDir}/**/*.ts`], {
    cwd: rootDir,
    onlyFiles: true,
    absolute: true,
    ignore: ['**/*.test.ts', '**/*.e2e.test.ts', '**/*.d.ts'],
  });
}
