import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'esbuild';
import { buildAliasPlugins } from './aliasPlugin';
import { collectRelativeImports } from './collectImports';
import { toProdExtension, toRealPath } from '../utils/prodPaths';

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
  /** 是否命中 mtime 短路缓存跳过了编译（watcher 重建场景，输入无变化时省 3 次 esbuild build） */
  skipped: boolean;
}

/**
 * compileConfig 的 mtime 短路缓存
 *
 * watcher 每次重建都会调 compileConfig；若无短路，即使配置源毫无变化，
 * 也要付出 3 次 esbuild build + collectRelativeImports 递归读整个依赖图的开销。
 *
 * key 为 `rootDir::dist`，value 记录上次编译的全部输入文件 mtime。
 * 再次调用时输入文件集合 mtime 全部一致且产物仍存在 → 跳过编译；
 * 任一变化/缺失 → 全量重编译并更新缓存。编译抛错时不写缓存（下次可重试）。
 */
interface CompileConfigCacheEntry {
  /** 上次编译的输入文件（绝对路径 → mtimeMs） */
  inputs: Map<string, number>;
  /** 主产物绝对路径（faapi-config.js） */
  outputFile: string;
}

const compileConfigCache = new Map<string, CompileConfigCacheEntry>();

/** 检查缓存是否仍然新鲜：产物存在 + 全部输入文件存在且 mtime 一致 */
async function isCacheFresh(entry: CompileConfigCacheEntry): Promise<boolean> {
  try {
    await fs.promises.stat(entry.outputFile);
  } catch {
    return false;
  }
  for (const [filePath, mtimeMs] of entry.inputs) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs !== mtimeMs) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 匹配 from '...' / from "..." / import('...') / import("...") 中的 specifier
 * 与递归收集逻辑见 collectImports.ts（compileConfig 与 compileOnDemand 共用）
 */

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
 * 编译 src 外入口文件及其项目内依赖闭包（compileConfig / 本地 TS 插件编译共用）
 *
 * - 入口 + src 外依赖：outbase=rootDir，产物在 `<dist>/` 下保留相对结构
 *   （如 `plugins/db-skills.ts` → `dist/plugins/db-skills.js`）
 * - src 内依赖：outbase=rootDir/src（打平前缀，与 compileDevRoutes 一致），
 *   使入口产物 import 的 src 内模块与 routes/config 共享同一份产物（instanceof 生效）
 * - aliasPlugin 重写 specifier：相对路径加 .js 后缀；src 外 importer 引用 src 内
 *   模块时剥离前缀（import 路径相对 importer 产物位置计算，见 aliasPlugin 的
 *   toProdImportFromImporter）
 *
 * @param entryPoints src 外入口文件（绝对路径）；src 内入口请走 compileDevRoutes /
 *                    compileBuildRoutes / ensureCompiled（打平产物 + 同一运行时对象）
 * @returns 收集到的 src 内/外依赖文件（供调用方记录 mtime 缓存）
 */
export async function compileProjectModules(
  entryPoints: string[],
  rootDir: string,
  dist: string,
): Promise<{ insideFiles: string[]; outsideFiles: string[] }> {
  const { insideFiles, outsideFiles } = await collectRelativeImports(entryPoints, rootDir);

  const esbuild = await import('esbuild');
  const aliasPlugins = buildAliasPlugins(rootDir);
  const absDist = path.resolve(rootDir, dist);

  // src 外文件（outbase=rootDir）：入口 + src 外依赖，产物保留相对结构
  await esbuild.build({
    entryPoints: [...entryPoints, ...outsideFiles],
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

  // src 内依赖（outbase=rootDir/src，打平前缀，与 compileDevRoutes 一致）
  if (insideFiles.length > 0) {
    const appOutbase = path.resolve(rootDir, 'src');
    await esbuild.build({
      entryPoints: insideFiles,
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

  return { insideFiles, outsideFiles };
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
    return { generated: false, outputFile: '', skipped: false };
  }

  const absDist = path.resolve(rootDir, dist);
  await fs.promises.mkdir(absDist, { recursive: true });

  const outputFile = path.resolve(absDist, 'faapi-config.js');
  const cacheKey = `${toRealPath(rootDir)}::${dist}`;

  // mtime 短路：上次编译的全部输入文件无变化且产物仍存在 → 跳过编译
  const cached = compileConfigCache.get(cacheKey);
  if (cached && (await isCacheFresh(cached))) {
    return { generated: true, outputFile: cached.outputFile, skipped: true };
  }
  compileConfigCache.delete(cacheKey);

  // 收集 config 入口文件（绝对路径）
  const configEntryPoints: string[] = [path.resolve(rootDir, baseConfigName)];

  // 步骤 1：逐文件编译 config 源 + 项目模块（共享实现见 compileProjectModules）
  const { insideFiles: appDirFiles, outsideFiles: nonAppDirFiles } = await compileProjectModules(
    configEntryPoints,
    rootDir,
    dist,
  );

  // 步骤 2：编译入口（bundle:true + external 相对路径）
  // 入口源码 import 已编译的 config 产物（带 .js 后缀）+ export base
  const baseImport = `import base from './${toProdImport(baseConfigName)}';`;
  const exportDefault = 'export default base;';

  const entryCode = [baseImport, exportDefault].join('\n');

  const esbuild = await import('esbuild');
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

  // 编译成功：记录全部输入文件的 mtime（config 源 + src 内/外依赖模块 + tsconfig——
  // alias 重写依赖 tsconfig paths，tsconfig 变化必须触发重编译），
  // 供下次调用的 mtime 短路判断。编译抛错时不走此处（下次可重试）。
  const inputs = new Map<string, number>();
  const tsconfigPath = path.resolve(rootDir, 'tsconfig.json');
  const inputCandidates = [
    ...configEntryPoints,
    ...appDirFiles,
    ...nonAppDirFiles,
    ...(fs.existsSync(tsconfigPath) ? [tsconfigPath] : []),
  ];
  for (const filePath of inputCandidates) {
    try {
      const stat = await fs.promises.stat(filePath);
      inputs.set(filePath, stat.mtimeMs);
    } catch {
      // 收集阶段存在的文件理论上不会消失；消失则不缓存该文件，下次触发重编译
    }
  }
  compileConfigCache.set(cacheKey, { inputs, outputFile });

  return { generated: true, outputFile, skipped: false };
}
