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
 * 规范化路径为 realpath（处理 macOS /tmp → /private/tmp 等符号链接场景）
 *
 * 目录不存在时回退到原路径（不抛错），保证调用方逻辑稳定。
 */
function toRealPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 判断 filePath 是否位于 dir 目录下（不依赖路径前缀字符串比较，兼容符号链接规范化差异）
 *
 * 基于 `path.relative`：相对路径不以 `..` 开头且非绝对路径时视为位于 dir 下。
 * 调用前应先用 `toRealPath` 规范化两侧路径，确保前缀一致。
 */
function isInsideDir(filePath: string, dir: string): boolean {
  const rel = path.relative(dir, filePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 把 appDir 下的源文件路径转为剥离 appDir 前缀的产物 import 路径（POSIX 风格，带 .js 后缀）
 *
 * 用于 config 文件（位于 rootDir，不在 appDir 下）引用 appDir 内模块的场景：
 * - 源文件 `<rootDir>/src/lib/errors.ts` → 产物 `outDir/lib/errors.js`
 * - config 产物位于 `outDir/faapi.config.js`（outDir 根）
 * - import 路径相对 outDir 根：`./lib/errors.js`
 *
 * 与 `toProdImportPath` 的区别：后者相对 importer 目录（适用于 importer 也在 appDir 内的场景，
 * outbase 打平后相对结构不变）；本函数相对 appDir 根（适用于 importer 在 appDir 外的场景，
 * 需要剥离 appDir 前缀以匹配 compileDevRoutes 的打平产物结构）。
 *
 * 内部用 `toRealPath` 规范化 appDirAbs，兼容 macOS 符号链接（esbuild onLoad 传入的
 * args.path 已是 realpath，未规范化的 appDirAbs 会导致前缀比较失败）。
 */
function toStrippedProdImportPath(sourceFile: string, rootDir: string, appDir: string): string {
  const appDirAbs = toRealPath(path.resolve(rootDir, appDir));
  const sourceReal = toRealPath(sourceFile);
  let rel = path.relative(appDirAbs, sourceReal);
  rel = rel.split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return toProdExtension(rel);
}

/**
 * aliasPlugin 扩展选项
 *
 * - `rootDir` + `appDir`：启用 appDir 前缀剥离。当 importer 不在 appDir 下（如 config 文件）
 *   且引用的源文件在 appDir 下时，重写为剥离前缀的产物路径（相对 outDir 根），以匹配
 *   `compileDevRoutes`/`compileBuildRoutes` 的打平产物结构。
 */
export interface AliasPluginOptions {
  /** 项目根目录（启用剥离时必填） */
  rootDir?: string;
  /** app 目录前缀，如 'src'（启用剥离时必填） */
  appDir?: string;
}

/**
 * 产物后缀集合（已带这些后缀的 specifier 视为产物路径，不重写）
 */
const PROD_EXTS = ['.js', '.mjs', '.cjs'];

/**
 * 源文件后缀集合（重写时尝试这些后缀定位实际文件）
 */
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * index 文件后缀集合（specifier 指向目录时尝试）
 */
const INDEX_EXTS = [
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
  '/index.mjs',
  '/index.cjs',
];

/**
 * 解析相对 specifier 到实际源文件绝对路径
 *
 * - 已带产物后缀（.js/.mjs/.cjs）且文件存在 → 返回该路径（不重写）
 * - 已带源后缀（.ts/.tsx/.jsx）且文件存在 → 返回该路径（重写为 .js）
 * - 无后缀 → 尝试各源后缀 + index 文件
 *
 * @param importer 导入文件绝对路径
 * @param specifier 相对 specifier（./xxx 或 ../xxx）
 * @returns 解析到的源文件绝对路径，或 null（未解析到）
 */
export function resolveRelativeSpecifier(importer: string, specifier: string): string | null {
  const importerDir = path.dirname(importer);
  const base = path.resolve(importerDir, specifier);

  // 已带产物后缀：文件存在则返回（视为产物路径，不重写）
  if (PROD_EXTS.some((ext) => specifier.endsWith(ext))) {
    return fs.existsSync(base) ? base : null;
  }

  // 已带源后缀：文件存在则返回（将重写为产物后缀）
  if (/\.(ts|tsx|jsx)$/.test(specifier)) {
    return fs.existsSync(base) ? base : null;
  }

  // 无后缀：尝试各源后缀
  for (const ext of SOURCE_EXTS) {
    const file = base + ext;
    if (fs.existsSync(file)) return file;
  }

  // 无后缀：尝试 index 文件
  for (const indexExt of INDEX_EXTS) {
    const file = base + indexExt;
    if (fs.existsSync(file)) return file;
  }

  return null;
}

/**
 * esbuild specifier 重写插件（dev/build/config 编译共用）
 *
 * 在 `onLoad` 阶段把源码 import/export 中的 specifier 重写为产物相对路径（带 `.js` 后缀）：
 *
 * 1. **相对 specifier**（`./xxx`、`../xxx`）：解析到实际源文件，重写为产物相对路径。
 *    - 无后缀 → 解析 + 加 `.js`
 *    - `.ts`/`.tsx`/`.jsx` → 改为 `.js`
 *    - `.js`/`.mjs`/`.cjs` → 不处理（视为产物路径）
 *    - 解析失败（文件不存在）→ 原样保留
 *
 * 2. **别名 specifier**（tsconfig.paths，如 `@/xxx`）：调 `resolveAlias` 解析候选路径，
 *    命中则重写为产物相对路径。
 *
 * `bundle: false` 模式下 esbuild 不递归解析依赖（`onResolve` 不触发），specifier 会原样
 * 保留到产物 `.js`，运行时 Node.js ESM loader 无法解析（无后缀推断）。本插件通过
 * `onLoad` 介入，确保产物中所有相对 import 都带 `.js` 后缀。
 *
 * **appDir 前缀剥离**（可选，通过 `options.rootDir` + `options.appDir` 启用）：
 * 当 importer 不在 appDir 下（如 `faapi.config.ts` 位于 rootDir）且引用的源文件在 appDir 下时，
 * 重写为剥离 appDir 前缀的产物路径（相对 outDir 根），以匹配 `compileDevRoutes`/`compileBuildRoutes`
 * 的打平产物结构。典型场景：config 引用项目模块（如 `./src/lib/errors` → `./lib/errors.js`），
 * 使 config 与 routes 共享同一份模块产物，`instanceof` 跨边界生效。
 *
 * 覆盖的 import 形式：
 * - `import { x } from './base'` / `import { x } from '@/base'`
 * - `export { x } from './base'`（含 `from`，被同一正则匹配）
 * - `import('./base')`（动态）
 *
 * 绝对路径（`/`）、`file:` URL、`node:` 协议不处理，交 esbuild 默认。
 */
export function createAliasPlugin(
  config: TsconfigPathsConfig,
  options?: AliasPluginOptions,
): Plugin {
  // 匹配 from '...' / from "..." 和 import('...') / import("...")
  const SPEC_RE = /(\bfrom\s*|import\s*\(\s*)(['"])([^'"]+)\2/g;
  // 预计算 appDir 绝对路径（realpath 规范化，用于判断 importer 和 resolved 是否在 appDir 内）
  // 规范化是为了兼容 macOS 符号链接：esbuild onLoad 传入的 args.path 是 realpath，
  // 未规范化的 appDirAbs 会导致 isInsideDir 比较失败（/var/folders vs /private/var/folders）
  const appDirAbs =
    options?.rootDir && options?.appDir
      ? toRealPath(path.resolve(options.rootDir, options.appDir))
      : null;
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
        // importer 是否在 appDir 外（启用剥离时才计算，用 isInsideDir 兼容符号链接）
        const importerOutsideAppDir = appDirAbs ? !isInsideDir(importer, appDirAbs) : false;
        let modified = false;
        const newSource = source.replace(SPEC_RE, (full, prefix, quote, specifier) => {
          // 绝对路径 / file: URL / node: 协议不处理
          if (
            specifier.startsWith('/') ||
            specifier.startsWith('file:') ||
            specifier.startsWith('node:')
          ) {
            return full;
          }

          // 相对 specifier（./ 或 ../）：解析到实际文件并重写
          if (specifier.startsWith('./') || specifier.startsWith('../')) {
            const resolved = resolveRelativeSpecifier(importer, specifier);
            if (resolved) {
              // 已带产物后缀的 specifier 不重写（resolveRelativeSpecifier 返回原路径）
              if (PROD_EXTS.some((ext) => specifier.endsWith(ext))) {
                return full;
              }
              // appDir 前缀剥离：importer 在 appDir 外、resolved 在 appDir 内
              // → 重写为剥离前缀的产物路径（相对 outDir 根）
              if (appDirAbs && importerOutsideAppDir && isInsideDir(resolved, appDirAbs)) {
                modified = true;
                return `${prefix}${quote}${toStrippedProdImportPath(
                  resolved,
                  options!.rootDir!,
                  options!.appDir!,
                )}${quote}`;
              }
              modified = true;
              return `${prefix}${quote}${toProdImportPath(resolved, importer)}${quote}`;
            }
            return full;
          }

          // 别名 specifier：调 resolveAlias 解析
          const candidates = resolveAlias(specifier, config);
          for (const candidate of candidates) {
            for (const ext of SOURCE_EXTS) {
              const file = candidate + ext;
              if (fs.existsSync(file)) {
                modified = true;
                // 别名解析到的文件如果在 appDir 内且 importer 在 appDir 外，同样剥离前缀
                if (appDirAbs && importerOutsideAppDir && isInsideDir(file, appDirAbs)) {
                  return `${prefix}${quote}${toStrippedProdImportPath(
                    file,
                    options!.rootDir!,
                    options!.appDir!,
                  )}${quote}`;
                }
                return `${prefix}${quote}${toProdImportPath(file, importer)}${quote}`;
              }
            }
            for (const indexExt of INDEX_EXTS) {
              const file = candidate + indexExt;
              if (fs.existsSync(file)) {
                modified = true;
                if (appDirAbs && importerOutsideAppDir && isInsideDir(file, appDirAbs)) {
                  return `${prefix}${quote}${toStrippedProdImportPath(
                    file,
                    options!.rootDir!,
                    options!.appDir!,
                  )}${quote}`;
                }
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
 * 读取 tsconfig paths 并构造 specifier 重写插件
 *
 * 始终返回含本插件的数组：相对路径重写不依赖 tsconfig（`bundle: false` 下 Node ESM 必需），
 * 别名重写依赖 tsconfig.paths（无 paths 时别名不重写）。
 *
 * @param rootDir 项目根目录
 * @param appDir app 目录前缀（如 'src'）。传入时启用 appDir 前缀剥离：importer 在 appDir 外
 *               且引用 appDir 内文件时，重写为剥离前缀的产物路径。主要用于 compileConfig
 *               编译 config 文件（位于 rootDir）引用项目模块（位于 appDir）的场景。
 */
export function buildAliasPlugins(rootDir: string, appDir?: string): Plugin[] {
  const tsconfig = readTsconfig(rootDir);
  return [
    createAliasPlugin(
      tsconfig ?? { baseUrl: '.', paths: {} },
      appDir ? { rootDir, appDir } : undefined,
    ),
  ];
}
