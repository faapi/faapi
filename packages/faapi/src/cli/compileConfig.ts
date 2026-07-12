import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'esbuild';
import { buildAliasPlugins, resolveRelativeSpecifier } from './aliasPlugin';

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
 * 基础配置文件查找顺序（与 loadConfig 保持一致）
 */
const BASE_CONFIG_FILES = ['faapi.config.ts', 'faapi.config.js'];

/**
 * 查找基础配置文件（返回源文件名，含后缀）
 *
 * 返回相对 rootDir 的路径（如 'faapi.config.ts'），供 esbuild 作为 entryPoint。
 */
function findBaseConfig(rootDir: string): string | null {
  for (const f of BASE_CONFIG_FILES) {
    if (fs.existsSync(path.join(rootDir, f))) {
      return f;
    }
  }
  return null;
}

/**
 * 源文件后缀 → 产物后缀（.ts/.tsx/.jsx → .js，其余原样）
 */
function toProdExtension(filePath: string): string {
  if (filePath.endsWith('.ts')) return filePath.slice(0, -3) + '.js';
  if (filePath.endsWith('.tsx')) return filePath.slice(0, -4) + '.js';
  if (filePath.endsWith('.jsx')) return filePath.slice(0, -4) + '.js';
  return filePath;
}

/**
 * 配置文件名 → 产物 import 名（如 'faapi.config.ts' → 'faapi.config.js'）
 */
function toProdImport(filename: string): string {
  return toProdExtension(filename);
}

export interface CompileConfigOptions {
  /** 项目根目录 */
  rootDir: string;
  /** 输出目录（如 dist） */
  dist: string;
}

export interface CompileConfigResult {
  /** 是否生成了配置产物（无基础配置文件时不生成） */
  generated: boolean;
  /** 输出文件绝对路径（generated=false 时为空字符串） */
  outputFile: string;
}

/**
 * 匹配 from '...' / from "..." / import('...') / import("...") 中的 specifier
 */
const SPEC_RE = /(\bfrom\s*|import\s*\(\s*)(['"])([^'"]+)\2/g;

/**
 * 从源文件内容中提取所有相对 specifier（./xxx 或 ../xxx）
 *
 * 用于递归收集 config 引用的项目模块，确保它们被编译到 dist，
 * 使 config 产物的 import 在运行时能解析到实际文件。
 */
function extractRelativeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;
  SPEC_RE.lastIndex = 0;
  while ((match = SPEC_RE.exec(source)) !== null) {
    const specifier = match[3];
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * 递归收集文件的所有相对 import（含传递依赖），分类为 src 内 / src 外
 *
 * 用于 compileConfig 步骤 1：编译 config 源 + 其引用的项目模块到 dist。
 * - src 内文件：用 outbase=rootDir/src 编译（打平前缀，与 compileDevRoutes 一致）
 * - src 外文件：用 outbase=rootDir 编译（保留相对 rootDir 的结构）
 *
 * @param entryFiles 起始文件（绝对路径）
 * @param rootDir 项目根目录
 * @returns 收集到的文件，分为 src 内和 src 外两组（绝对路径，去重）
 */
async function collectRelativeImports(
  entryFiles: string[],
  rootDir: string,
): Promise<{ appDirFiles: string[]; nonAppDirFiles: string[] }> {
  // 用 realpath 规范化 src 绝对路径，兼容 macOS 符号链接（esbuild 传入的路径已是 realpath）
  const appDirAbs = toRealPath(path.resolve(rootDir, 'src'));
  const visited = new Set<string>();
  const appDirFiles = new Set<string>();
  const nonAppDirFiles = new Set<string>();

  async function collect(filePath: string): Promise<void> {
    if (visited.has(filePath)) return;
    visited.add(filePath);

    let source: string;
    try {
      source = await fs.promises.readFile(filePath, 'utf8');
    } catch {
      return;
    }

    const specifiers = extractRelativeSpecifiers(source);
    for (const specifier of specifiers) {
      const resolved = resolveRelativeSpecifier(filePath, specifier);
      if (!resolved) continue;

      // 已带产物后缀的 specifier（.js/.mjs/.cjs）不递归（视为已编译产物，源码不在此处）
      if (/\.(js|mjs|cjs)$/.test(specifier)) continue;

      if (isInsideDir(resolved, appDirAbs)) {
        appDirFiles.add(resolved);
      } else {
        nonAppDirFiles.add(resolved);
      }
      await collect(resolved);
    }
  }

  for (const entry of entryFiles) {
    await collect(entry);
  }

  return {
    appDirFiles: Array.from(appDirFiles),
    nonAppDirFiles: Array.from(nonAppDirFiles),
  };
}

/**
 * 创建 external 相对路径插件（步骤 2 用）
 *
 * 在 `bundle: true` 模式下，把所有相对路径 import（./xxx 或 ../xxx）标记为 external，
 * 阻止 esbuild 把已编译的 config 产物 inline 进 faapi-config.js。
 *
 * 这使 faapi-config.js 保留 `import base from './faapi.config.js'` 语句，运行时
 * Node.js ESM loader 加载 faapi.config.js，后者再 import 项目模块产物——
 * 与 routes 编译的同一文件共享，instanceof 生效。
 */
function createExternalRelativePlugin(): Plugin {
  return {
    name: 'faapi-external-relative',
    setup(build) {
      // 相对路径（./ 或 ../开头）标记为 external
      build.onResolve({ filter: /^\.{1,2}\// }, (args) => ({
        path: args.path,
        external: true,
      }));
    },
  };
}

/**
 * build 时编译配置文件，生成 `dist/faapi-config.js`
 *
 * 采用两步编译，使 config 引用的项目模块与 routes 共享同一份运行时对象（instanceof 跨边界生效）：
 *
 * **步骤 1：逐文件编译 config 源文件（`bundle: false`）**
 * - 编译 `faapi.config.ts` → `dist/faapi.config.js`
 * - 递归收集 config 引用的项目模块，按 src 内/外分别编译：
 *   - src 内：outbase=rootDir/src（打平前缀，与 compileDevRoutes 一致）→ `dist/lib/errors.js`
 *   - src 外：outbase=rootDir → `dist/base.js`
 * - aliasPlugin 重写 specifier：相对路径加 .js 后缀；config 引用 src 内模块时剥离前缀
 *
 * **步骤 2：编译合并入口（`bundle: true` + external 相对路径）**
 * - 生成虚拟入口源码（import 已编译的 config 产物 + export base）
 * - 相对路径 import 标记为 external（不 inline config 产物）
 * - 第三方依赖（`packages: 'external'`）也保持 external
 * - 产物 `dist/faapi-config.js` 保留 `import base from './faapi.config.js'`
 *
 * 产物由 `loadConfig` 在运行时统一 import。环境变量通过 `.env` 文件加载（见 `loadEnv`），
 * 配置文件中通过 `process.env.XXX` 读取，运行时取值。不传 `define`，保留 `process.env` 表达式。
 */
export async function compileConfig(options: CompileConfigOptions): Promise<CompileConfigResult> {
  const { rootDir, dist } = options;

  const baseConfigName = findBaseConfig(rootDir);
  if (!baseConfigName) {
    // 无基础配置文件：不生成产物，loadConfig 会返回 null
    return { generated: false, outputFile: '' };
  }

  const absDist = path.resolve(rootDir, dist);
  await fs.promises.mkdir(absDist, { recursive: true });

  // 收集 config 入口文件（绝对路径）
  const configEntryPoints: string[] = [path.resolve(rootDir, baseConfigName)];

  // 步骤 1：逐文件编译 config 源 + 项目模块
  // 递归收集 config 引用的项目模块
  const { appDirFiles, nonAppDirFiles } = await collectRelativeImports(configEntryPoints, rootDir);

  const esbuild = await import('esbuild');
  const aliasPlugins = buildAliasPlugins(rootDir);

  // 步骤 1a：编译 config 源 + src 外文件（outbase=rootDir）
  // config 文件位于 rootDir，产物位于 dist 根（如 dist/faapi.config.js）
  // src 外文件（如 rootDir/base.ts）产物位于 dist/base.js
  const step1aEntries = [...configEntryPoints, ...nonAppDirFiles];
  await esbuild.build({
    entryPoints: step1aEntries,
    outdir: absDist,
    outbase: rootDir,
    bundle: false,
    platform: 'node',
    format: 'esm',
    sourcemap: true,
    packages: 'external',
    plugins: aliasPlugins,
    logLevel: 'silent',
  });

  // 步骤 1b：编译 src 内文件（outbase=rootDir/src，打平前缀）
  // 与 compileDevRoutes 一致的 outbase，确保产物路径相同（如 dist/lib/errors.js）
  if (appDirFiles.length > 0) {
    const appOutbase = path.resolve(rootDir, 'src');
    await esbuild.build({
      entryPoints: appDirFiles,
      outdir: absDist,
      outbase: appOutbase,
      bundle: false,
      platform: 'node',
      format: 'esm',
      sourcemap: true,
      packages: 'external',
      plugins: aliasPlugins,
      logLevel: 'silent',
    });
  }

  // 步骤 2：编译入口（bundle:true + external 相对路径）
  // 入口源码 import 已编译的 config 产物（带 .js 后缀）+ export base
  const baseImport = `import base from './${toProdImport(baseConfigName)}';`;
  const exportDefault = 'export default base;';

  const entryCode = [baseImport, exportDefault].join('\n');

  const outputFile = path.resolve(absDist, 'faapi-config.js');
  await esbuild.build({
    stdin: { contents: entryCode, resolveDir: absDist, loader: 'ts' },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    packages: 'external',
    plugins: [createExternalRelativePlugin()],
    logLevel: 'silent',
  });

  return { generated: true, outputFile };
}
