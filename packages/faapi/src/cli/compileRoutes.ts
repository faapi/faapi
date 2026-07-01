import { readTsconfig } from '../utils/readTsconfig';
import { resolveAlias } from '../utils/resolveAlias';
import type { TsconfigPathsConfig } from '../utils/readTsconfig';
import type { Plugin } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import fg from 'fast-glob';

/**
 * 编译选项
 */
export interface CompileOptions {
  /** 项目根目录 */
  rootDir: string;
  /** app 目录前缀（如 src） */
  appDir: string;
  /** 输出目录（如 .faapi/dev 或 dist） */
  outDir: string;
  /**
   * 增量编译：传入要编译的文件列表（绝对路径）。
   * 不传则全量编译 appDir 下所有 .ts（排除测试文件和声明文件）。
   */
  files?: string[];
  /** 是否输出 esbuild 日志（dev 模式静默，build 模式输出） */
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
 * 源文件后缀 → 产物后缀映射
 *
 * .ts/.tsx/.jsx → .js；.mjs/.cjs/.js 保持。
 */
function toProdExtension(filePath: string): string {
  if (filePath.endsWith('.ts')) return filePath.slice(0, -3) + '.js';
  if (filePath.endsWith('.tsx')) return filePath.slice(0, -4) + '.js';
  if (filePath.endsWith('.jsx')) return filePath.slice(0, -4) + '.js';
  return filePath;
}

/**
 * 把候选源文件路径转为产物 import 路径（相对 importer，POSIX 风格，带 .js 后缀）
 */
function toProdImportPath(sourceFile: string, importer: string): string {
  const importerDir = path.dirname(importer);
  let rel = path.relative(importerDir, sourceFile);
  rel = rel.split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return toProdExtension(rel);
}

/**
 * esbuild 别名重写插件
 *
 * `bundle: false` 模式下 esbuild 不递归解析依赖（onResolve 不触发），
 * 因此改用 onLoad：读取源文件后，把 import/export 中的别名 specifier
 * 替换为产物相对路径（.js 后缀），再交给 esbuild 转译。运行时无需 loader。
 *
 * 覆盖的 import 形式：
 * - `import { x } from 'alias'`
 * - `export { x } from 'alias'`
 * - `import('alias')`（动态）
 *
 * 相对路径 / 绝对路径 / file: URL / node: 协议不处理，交 esbuild 默认。
 */
function createAliasPlugin(config: TsconfigPathsConfig): Plugin {
  const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  const INDEX_EXTS = [
    '/index.ts',
    '/index.tsx',
    '/index.js',
    '/index.jsx',
    '/index.mjs',
    '/index.cjs',
  ];
  // 匹配 from '...' / from "..." 和 import('...') / import("...")
  const SPEC_RE = /(\bfrom\s*|import\s*\(\s*)(['"])([^'"]+)\2/g;
  return {
    name: 'faapi-alias',
    setup(build) {
      build.onLoad({ filter: /\.(ts|tsx|js|jsx|mjs|cjs)$/ }, (args) => {
        let source: string;
        try {
          source = fs.readFileSync(args.path, 'utf8');
        } catch {
          return undefined;
        }
        const importer = args.path;
        let modified = false;
        const newSource = source.replace(SPEC_RE, (full, prefix, quote, specifier) => {
          if (
            specifier.startsWith('.') ||
            specifier.startsWith('/') ||
            specifier.startsWith('file:') ||
            specifier.startsWith('node:')
          ) {
            return full;
          }
          const candidates = resolveAlias(specifier, config);
          for (const candidate of candidates) {
            for (const ext of EXTS) {
              const file = candidate + ext;
              if (fs.existsSync(file)) {
                modified = true;
                return `${prefix}${quote}${toProdImportPath(file, importer)}${quote}`;
              }
            }
            for (const indexExt of INDEX_EXTS) {
              const file = candidate + indexExt;
              if (fs.existsSync(file)) {
                modified = true;
                return `${prefix}${quote}${toProdImportPath(file, importer)}${quote}`;
              }
            }
          }
          return full;
        });
        if (!modified) return undefined;
        return { contents: newSource, loader: 'default' };
      });
    },
  };
}

/**
 * 编译 TypeScript 文件到指定目录
 *
 * 使用 esbuild 逐文件编译（不 bundle），保持目录结构，
 * 这样运行时动态 import 的文件路径在编译后仍然有效。
 * 别名在编译时重写为相对路径，运行时无需 loader。
 *
 * @example
 * // dev：编译到 .faapi/dev/
 * await compileRoutes({ rootDir, appDir: 'src', outDir: '.faapi/dev' });
 * // build：编译到 dist/
 * await compileRoutes({ rootDir, appDir: 'src', outDir: 'dist', logLevel: 'info' });
 * // watch 增量：只编译变化的文件
 * await compileRoutes({ rootDir, appDir: 'src', outDir: '.faapi/dev', files: changedFiles });
 */
export async function compileRoutes(options: CompileOptions): Promise<CompileResult> {
  const { rootDir, appDir, outDir, files, logLevel = 'silent' } = options;

  // 收集要编译的 .ts 文件
  // 全量编译时扫描整个 appDir（覆盖路由、中间件、别名引用的依赖文件）
  // 增量编译时直接使用传入的文件列表
  const allFiles =
    files ??
    (await fg([`${appDir}/**/*.ts`], {
      cwd: rootDir,
      onlyFiles: true,
      absolute: true,
      ignore: ['**/*.test.ts', '**/*.e2e.test.ts', '**/*.d.ts'],
    }));

  if (allFiles.length === 0) {
    return { compiledFiles: [] };
  }

  // 确保输出目录存在
  const absOutDir = path.resolve(rootDir, outDir);
  await fs.promises.mkdir(absOutDir, { recursive: true });

  // 读取 tsconfig paths，构造别名重写插件（无 tsconfig/paths 时为空）
  const tsconfig = readTsconfig(rootDir);
  const plugins = tsconfig ? [createAliasPlugin(tsconfig)] : [];

  // 逐文件编译，保持目录结构（outbase 保证相对路径）
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: allFiles,
    outdir: absOutDir,
    outbase: rootDir,
    bundle: false,
    platform: 'node',
    format: 'esm',
    sourcemap: true,
    packages: 'external',
    plugins,
    logLevel,
  });

  return { compiledFiles: allFiles };
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
