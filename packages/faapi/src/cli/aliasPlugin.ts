import type { Plugin } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { resolveAlias } from '../utils/resolveAlias';
import { readTsconfig, type TsconfigPathsConfig } from '../utils/readTsconfig';

/**
 * 源文件后缀 → 产物后缀
 *
 * .ts/.tsx/.jsx → .js；.mjs/.cjs/.js 保持。
 */
export function toProdExtension(filePath: string): string {
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
 * esbuild 别名重写插件（dev/build 共用）
 *
 * `bundle: false` 模式下 esbuild 不递归解析依赖（onResolve 不触发），
 * 因此改用 onLoad：读取源文件后，把 import/export 中的别名 specifier
 * 替换为产物相对路径（.js 后缀），再交给 esbuild 转译。运行时无需 loader。
 *
 * bundle 模式下同样适用：onLoad 在 esbuild 解析前执行，别名被重写为相对路径后，
 * esbuild 的 bundle 逻辑跟随重写后的路径分析依赖树。
 *
 * 覆盖的 import 形式：
 * - `import { x } from 'alias'`
 * - `export { x } from 'alias'`
 * - `import('alias')`（动态）
 *
 * 相对路径 / 绝对路径 / file: URL / node: 协议不处理，交 esbuild 默认。
 */
export function createAliasPlugin(config: TsconfigPathsConfig): Plugin {
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
 * 读取 tsconfig paths 并构造别名重写插件（无 tsconfig/paths 时返回空数组）
 */
export function buildAliasPlugins(rootDir: string): Plugin[] {
  const tsconfig = readTsconfig(rootDir);
  return tsconfig ? [createAliasPlugin(tsconfig)] : [];
}
