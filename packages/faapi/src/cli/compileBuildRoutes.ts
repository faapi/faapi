import path from 'node:path';
import fs from 'node:fs';
import { buildAliasPlugins } from './aliasPlugin';
import type { CompileResult } from './compileDevRoutes';

/**
 * build 编译选项
 */
export interface CompileBuildOptions {
  /** 项目根目录 */
  rootDir: string;
  /** app 目录前缀（如 src） */
  appDir: string;
  /** 输出目录（build 模式为 `dist`） */
  outDir: string;
  /**
   * bundle 模式入口文件列表（绝对路径）。
   * esbuild 从 entries 出发跟随 import 链分析依赖树。
   */
  entries: string[];
  /**
   * 是否启用代码分割（共享依赖提取为 chunk）。
   * 默认 true。
   */
  splitting?: boolean;
  /**
   * 编译时常量替换（配合 bundle 做常量折叠 + dead code elimination）。
   * 例：{ 'process.env.NODE_ENV': '"production"' }
   * esbuild 会在编译时把匹配的表达式替换为给定字面量，
   * 随后的常量折叠会删除 `if (false) {...}` 等死分支。
   */
  define?: Record<string, string>;
  /**
   * 是否启用语法压缩（删除死分支、合并变量声明等，不缩短变量名、不压缩空白）。
   * 默认 true。
   * 配合 define 使用：define 把 `process.env.NODE_ENV` 替换为 'production' 后，
   * minifySyntax 会删除 `if (false) {...}` 块内的死代码。
   * 不影响产物可读性（变量名和格式保留），便于调试。
   */
  minifySyntax?: boolean;
  /** 是否输出 esbuild 日志（build 模式默认静默） */
  logLevel?: 'silent' | 'info';
}

/**
 * build 模式编译 TypeScript：bundle 模式 + tree shaking + 死分支删除
 *
 * esbuild 从 entries 出发跟随 import 链分析依赖树：
 * - `bundle: true`：跟随 import 链，未引用的 export 被删除（tree shaking）
 * - `splitting`：共享依赖（如 `utils.ts` 被多个 handler 引用）提取为 `chunk-<hash>.js`
 * - `define` + `minifySyntax`：编译时替换 `process.env.NODE_ENV` 并删除 `if (false) {...}` 死分支
 *
 * 产物**打平 appDir 前缀**：
 * - `src/api/hello/handler.ts` → `<outDir>/api/hello/handler.js`
 *
 * 别名在编译时重写为相对路径，运行时无需 loader。
 *
 * 框架采用零入口设计——用户无需编写 main.ts，dev/prod 启动由 CLI 内部编排。
 *
 * @example
 * await compileBuildRoutes({
 *   rootDir, appDir: 'src', outDir: 'dist',
 *   entries: [...handlerFiles, ...middlewareFiles, mainFile],
 *   splitting: true,
 *   define: { 'process.env.NODE_ENV': '"production"' },
 *   minifySyntax: true,
 * });
 */
export async function compileBuildRoutes(options: CompileBuildOptions): Promise<CompileResult> {
  const {
    rootDir,
    appDir,
    outDir,
    entries,
    splitting = true,
    define,
    minifySyntax = true,
    logLevel = 'silent',
  } = options;

  if (entries.length === 0) {
    return { compiledFiles: [] };
  }

  // 确保输出目录存在
  const absOutDir = path.resolve(rootDir, outDir);
  await fs.promises.mkdir(absOutDir, { recursive: true });

  // 构造别名重写插件（无 tsconfig/paths 时为空）
  const plugins = buildAliasPlugins(rootDir);

  // bundle 模式，outbase 设为 appDir 以打平产物结构
  const esbuild = await import('esbuild');
  const outbase = appDir === '.' ? rootDir : path.resolve(rootDir, appDir);
  await esbuild.build({
    entryPoints: entries,
    outdir: absOutDir,
    outbase,
    bundle: true,
    splitting,
    platform: 'node',
    format: 'esm',
    sourcemap: true,
    packages: 'external',
    plugins,
    define,
    minifySyntax,
    logLevel,
  });

  return { compiledFiles: entries };
}
