import type { Plugin } from 'esbuild';
import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';
import { resolveAlias } from '../utils/resolveAlias';
import { APP_DIR, isInsideDir, toProdExtension, toRealPath } from '../utils/prodPaths';
import { readTsconfig, type TsconfigPathsConfig } from '../utils/readTsconfig';

// 兼容 re-export：toProdExtension 此前由本模块导出
export { toProdExtension };

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
 * 把 src 下的源文件路径转为剥离 src/ 前缀的产物路径（相对 dist 根，POSIX 风格，带 .js 后缀）
 *
 * 用于 src 外 importer（config 文件、本地插件等，位于 rootDir）引用 src 内模块的场景：
 * - 源文件 `<rootDir>/src/lib/errors.ts` → 产物 `dist/lib/errors.js` → 相对 dist 根 `./lib/errors.js`
 *
 * 与 `toProdImportPath` 的区别：后者相对 importer 目录（适用于 importer 也在 src 内的场景，
 * outbase 打平后相对结构不变）；本函数相对 src 根（适用于 importer 在 src 外的场景，
 * 需要剥离 src/ 前缀以匹配 compileDevRoutes 的打平产物结构）。
 *
 * 内部用 `toRealPath` 规范化 appDirAbs，兼容 macOS 符号链接（esbuild onLoad 传入的
 * args.path 已是 realpath，未规范化的 appDirAbs 会导致前缀比较失败）。
 */
function toStrippedProdImportPath(sourceFile: string, rootDir: string): string {
  const appDirAbs = toRealPath(path.resolve(rootDir, APP_DIR));
  const sourceReal = toRealPath(sourceFile);
  let rel = path.relative(appDirAbs, sourceReal);
  rel = rel.split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return toProdExtension(rel);
}

/**
 * 把「相对 dist 根」的产物路径改写为「相对 importer 产物位置」的 import 路径
 *
 * src 外 importer 的产物位置 = importer 源文件相对 rootDir 的路径（.js 后缀），
 * 因为 src 外编译（compileConfig 步骤 1a / compileProjectModules）以 rootDir 为
 * outbase，产物在 `<dist>/` 下保留相对结构。
 *
 * - config `faapi.config.ts` → 产物 `faapi.config.js`（dist 根）→ `./lib/errors.js` 保持不变
 * - 插件 `plugins/db-skills.ts` → 产物 `plugins/db-skills.js`（dist 子目录）
 *   → 引用 `./lib/errors.js` 需改写为 `../lib/errors.js`（相对 dist 根的路径在
 *     子目录模块里会解析到 `plugins/lib/errors.js`，错位）
 */
function toProdImportFromImporter(importer: string, rootDir: string, relFromDist: string): string {
  // 两侧 realpath 归一化，兼容 macOS 符号链接（esbuild onLoad 传入的 importer 已是
  // realpath，rootDir 可能仍是 /var 形式——不归一化则 relative 产生绕行路径）
  const importerRel = path
    .relative(toRealPath(path.resolve(rootDir)), toRealPath(importer))
    .split(path.sep)
    .join('/');
  const importerProdDir = path.posix.dirname(toProdExtension(importerRel));
  if (importerProdDir === '.') return relFromDist;
  const target = relFromDist.replace(/^\.\//, '');
  let rel = path.posix.relative(importerProdDir, target);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

/**
 * aliasPlugin 扩展选项
 *
 * - `rootDir`：启用 src/ 前缀剥离。当 importer 不在 src 下（如 config 文件）
 *   且引用的源文件在 src 下时，重写为剥离前缀的产物路径（相对 dist 根），以匹配
 *   `compileDevRoutes`/`compileBuildRoutes` 的打平产物结构。
 */
export interface AliasPluginOptions {
  /** 项目根目录（启用剥离时必填） */
  rootDir?: string;
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
 * - `.js` 说明符对应产物文件不存在时回退探测 `.ts`/`.tsx`/`.jsx` 源
 *   （`moduleResolution: Node16` 风格的 `import './x.js'` 实际指向 `x.ts`，产物必有
 *   `x.js`）——返回源路径，调用方按"已带产物后缀"保持说明符原样
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
    if (fs.existsSync(base)) return base;
    // Node16 风格 .js 说明符 → .ts/.tsx/.jsx 源回退（产物必有对应 .js）
    if (base.endsWith('.js')) {
      for (const ext of ['.ts', '.tsx', '.jsx']) {
        const file = base.slice(0, -3) + ext;
        if (fs.existsSync(file)) return file;
      }
    }
    return null;
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
 * 在 `onLoad` 阶段用 TypeScript AST 定位源码中真实的 import/export/动态 import
 * 说明符（注释与字符串字面量天然不参与），重写为产物相对路径（带 `.js` 后缀）：
 *
 * 1. **相对 specifier**（`./xxx`、`../xxx`）：解析到实际源文件，重写为产物相对路径。
 *    - 无后缀 → 解析 + 加 `.js`
 *    - `.ts`/`.tsx`/`.jsx` → 改为 `.js`
 *    - `.js`/`.mjs`/`.cjs` → 不重写（视为产物路径）；`.js` 说明符在产物文件不存在时
 *      回退探测 `.ts`/`.tsx`/`.jsx` 源（Node16 风格 `import './x.js'` 指向 `x.ts`），
 *      探测到即确认产物必有对应 `.js`，保持原样
 *    - **解析失败（项目内不存在对应文件）→ 返回 esbuild error，构建直接失败**——
 *      `bundle: false` 下 esbuild 不解析依赖，静默保留会让源码笔误推迟到生产运行时
 *      （Node ESM 严格解析报 ERR_MODULE_NOT_FOUND）才暴露
 *
 * 2. **别名 specifier**（tsconfig.paths，如 `@/xxx`）：调 `resolveAlias` 解析候选路径，
 *    命中则重写为产物相对路径。解析失败保持原样——paths 只是候选提示，未命中时裸
 *    说明符可能仍由 node_modules 运行时解析，不误报
 *
 * `bundle: false` 模式下 esbuild 不递归解析依赖（`onResolve` 不触发），specifier 会原样
 * 保留到产物 `.js`，运行时 Node.js ESM loader 无法解析（无后缀推断）。本插件通过
 * `onLoad` 介入，确保产物中所有相对 import 都带 `.js` 后缀。
 *
 * **src/ 前缀剥离**（可选，通过 `options.rootDir` 启用）：
 * 当 importer 不在 src 下（如 `faapi.config.ts` 位于 rootDir）且引用的源文件在 src 下时，
 * 重写为剥离 src/ 前缀的产物路径（相对 dist 根），以匹配 `compileDevRoutes`/`compileBuildRoutes`
 * 的打平产物结构。典型场景：config 引用项目模块（如 `./src/lib/errors` → `./lib/errors.js`），
 * 使 config 与 routes 共享同一份模块产物，`instanceof` 跨边界生效。
 *
 * 覆盖的 import 形式（AST 定位，注释/字符串不误伤）：
 * - `import { x } from './base'` / `import { x } from '@/base'` / `import './base'`（副作用导入）
 * - `export { x } from './base'` / `export * from './base'`
 * - `import('./base')`（动态 import，仅字面量实参）
 *
 * 绝对路径（`/`）、`file:` URL、`node:` 协议不处理，交 esbuild 默认。
 */
export function createAliasPlugin(
  config: TsconfigPathsConfig,
  options?: AliasPluginOptions,
): Plugin {
  // 预计算 src 绝对路径（realpath 规范化，用于判断 importer 和 resolved 是否在 src 内）
  // 规范化是为了兼容 macOS 符号链接：esbuild onLoad 传入的 args.path 是 realpath，
  // 未规范化的 appDirAbs 会导致 isInsideDir 比较失败（/var/folders vs /private/var/folders）
  const appDirAbs = options?.rootDir ? toRealPath(path.resolve(options.rootDir, APP_DIR)) : null;

  /** 探测别名候选对应的源文件（源后缀 → index 文件） */
  const probeCandidateFile = (candidate: string): string | null => {
    for (const ext of SOURCE_EXTS) {
      const file = candidate + ext;
      if (fs.existsSync(file)) return file;
    }
    for (const indexExt of INDEX_EXTS) {
      const file = candidate + indexExt;
      if (fs.existsSync(file)) return file;
    }
    return null;
  };

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
        // importer 是否在 src 外（启用剥离时才计算，用 isInsideDir 兼容符号链接）
        const importerOutsideAppDir = appDirAbs ? !isInsideDir(importer, appDirAbs) : false;

        // AST 定位真实说明符——正则会误伤注释与字符串（注释掉的 `// import ... from './deleted'`
        // 会被当成真实导入，严格报错时大面积误报），TypeScript 解析器只给出真实节点与精确位置
        const sourceFile = ts.createSourceFile(importer, source, ts.ScriptTarget.Latest, false);
        const literals: ts.StringLiteral[] = [];
        const visit = (node: ts.Node): void => {
          // import type / export type 被编译器整体擦除，说明符不会进入产物——不重写也不报错
          if (ts.isImportDeclaration(node)) {
            if (!node.importClause?.isTypeOnly && node.moduleSpecifier) {
              if (ts.isStringLiteral(node.moduleSpecifier)) literals.push(node.moduleSpecifier);
            }
          } else if (ts.isExportDeclaration(node)) {
            if (!node.isTypeOnly && node.moduleSpecifier) {
              if (ts.isStringLiteral(node.moduleSpecifier)) literals.push(node.moduleSpecifier);
            }
          } else if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0])
          ) {
            literals.push(node.arguments[0]);
          }
          ts.forEachChild(node, visit);
        };
        ts.forEachChild(sourceFile, visit);

        const replacements: { start: number; end: number; text: string }[] = [];
        const unresolvable: ts.StringLiteral[] = [];

        for (const lit of literals) {
          const specifier = lit.text;
          // 绝对路径 / file: URL / node: 协议不处理
          if (
            specifier.startsWith('/') ||
            specifier.startsWith('file:') ||
            specifier.startsWith('node:')
          ) {
            continue;
          }

          // 相对 specifier（./ 或 ../）：解析到实际文件并重写
          if (specifier.startsWith('./') || specifier.startsWith('../')) {
            const resolved = resolveRelativeSpecifier(importer, specifier);
            if (!resolved) {
              unresolvable.push(lit);
              continue;
            }
            // 已带产物后缀的说明符不重写（含 .js → .ts 源回退命中的 Node16 风格，产物必有 .js）
            if (PROD_EXTS.some((ext) => specifier.endsWith(ext))) continue;

            let prodPath: string;
            // src 前缀剥离：importer 在 src 外、resolved 在 src 内
            // → 重写为剥离前缀的产物路径（相对 importer 产物位置）
            if (appDirAbs && importerOutsideAppDir && isInsideDir(resolved, appDirAbs)) {
              prodPath = toProdImportFromImporter(
                importer,
                options!.rootDir!,
                toStrippedProdImportPath(resolved, options!.rootDir!),
              );
            } else {
              prodPath = toProdImportPath(resolved, importer);
            }
            const quote = source[lit.getStart(sourceFile)];
            replacements.push({
              start: lit.getStart(sourceFile),
              end: lit.getEnd(),
              text: quote + prodPath + quote,
            });
            continue;
          }

          // 别名 specifier：调 resolveAlias 解析
          for (const candidate of resolveAlias(specifier, config)) {
            const file = probeCandidateFile(candidate);
            if (!file) continue;

            let prodPath: string;
            if (appDirAbs && importerOutsideAppDir && isInsideDir(file, appDirAbs)) {
              prodPath = toProdImportFromImporter(
                importer,
                options!.rootDir!,
                toStrippedProdImportPath(file, options!.rootDir!),
              );
            } else {
              prodPath = toProdImportPath(file, importer);
            }
            const quote = source[lit.getStart(sourceFile)];
            replacements.push({
              start: lit.getStart(sourceFile),
              end: lit.getEnd(),
              text: quote + prodPath + quote,
            });
            break;
          }
        }

        if (unresolvable.length > 0) {
          const lineStarts = sourceFile.getLineStarts();
          return {
            errors: unresolvable.map((lit) => {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(
                lit.getStart(sourceFile),
              );
              const lineEnd =
                line + 1 < lineStarts.length ? lineStarts[line + 1] : sourceFile.getEnd();
              return {
                text: `无法解析的相对导入 "${lit.text}"——项目内不存在对应源文件（faapi 逐文件编译（bundle: false）不解析依赖，该导入会原样进入产物，生产 Node ESM 运行时报 ERR_MODULE_NOT_FOUND）。请修正路径或补全后缀`,
                location: {
                  file: importer,
                  line: line + 1,
                  column: character,
                  lineText: source.slice(lineStarts[line], lineEnd).replace(/\r?\n$/, ''),
                },
              };
            }),
          };
        }

        if (replacements.length === 0) return undefined;
        // 从后往前应用替换，避免前面的替换使后面的位置失效
        replacements.sort((a, b) => b.start - a.start);
        let newSource = source;
        for (const r of replacements) {
          newSource = newSource.slice(0, r.start) + r.text + newSource.slice(r.end);
        }
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
 * @param rootDir 项目根目录。传入时启用 src/ 前缀剥离：importer 在 src 外
 *               且引用 src 内文件时，重写为剥离前缀的产物路径。主要用于 compileConfig
 *               编译 config 文件（位于 rootDir）引用项目模块（位于 src）的场景。
 */
export function buildAliasPlugins(rootDir: string): Plugin[] {
  const tsconfig = readTsconfig(rootDir);
  return [createAliasPlugin(tsconfig ?? { baseUrl: '.', paths: {} }, { rootDir })];
}
