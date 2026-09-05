import path from 'node:path';
import fs from 'node:fs';
import { isInsideDir, toRealPath } from '../utils/prodPaths';
import { resolveRelativeSpecifier } from './aliasPlugin';
import { resolveAlias } from '../utils/resolveAlias';
import { readTsconfig } from '../utils/readTsconfig';

/**
 * 匹配 from '...' / from "..." / import('...') / import("...") 中的 specifier
 */
const SPEC_RE = /(\bfrom\s*|import\s*\(\s*)(['"])([^'"]+)\2/g;

/**
 * 从源文件内容中提取所有 import specifier
 *
 * 覆盖相对 specifier（./xxx、../xxx）与 tsconfig paths 别名 specifier（如 @/xxx）。
 * 动态 import（import('...')）同样覆盖。
 */
function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;
  SPEC_RE.lastIndex = 0;
  while ((match = SPEC_RE.exec(source)) !== null) {
    specifiers.push(match[3]!);
  }
  return specifiers;
}

/**
 * 从目录解析 specifier 为源文件绝对路径（探测 .ts/.tsx 等源后缀与 index 文件）
 *
 * 复用 resolveRelativeSpecifier 的探测逻辑：它按 importer 文件所在目录解析，
 * 传入目录内的合成文件名即可从指定目录解析。
 */
function resolveSpecifierFromDir(dir: string, specifier: string): string | null {
  return resolveRelativeSpecifier(path.join(dir, '__faapi_probe__.ts'), specifier);
}

/**
 * 递归收集入口文件的所有项目内 import 依赖（含传递依赖），按是否位于 appDir 内分组
 *
 * 供两类调用方使用：
 * - `compileConfig`：编译 config 源 + 其引用的项目模块，使 config 产物的 import
 *   在运行时能解析到实际文件（与 routes 编译的同一产物共享，instanceof 跨边界生效）
 * - `compileOnDemand.ensureCompiled`：dev 按需编译 handler 时补齐依赖闭包，
 *   否则 handler 引用的共享模块（如 `../../lib/db`）产物不存在，首次请求即
 *   ERR_MODULE_NOT_FOUND
 *
 * 解析规则：
 * - 相对 specifier：`resolveRelativeSpecifier` 探测源后缀与 index 文件
 * - 别名 specifier（tsconfig paths，如 `@/lib/db`）：`resolveAlias` 解析候选目标后
 *   同样探测源后缀（无 tsconfig/paths 时跳过）
 * - 已带产物后缀（.js/.mjs/.cjs）的 specifier 不递归（视为已编译产物，源码不在此处）
 * - 项目外依赖（node_modules、rootDir 外文件）不收集——按 external 语义运行时解析
 *
 * @param entryFiles 起始文件（绝对路径）
 * @param rootDir 项目根目录
 * @returns 收集到的文件，分为 src 内（打平前缀编译）和 src 外（保留结构编译）两组
 *          （绝对路径，去重，不含入口文件本身）
 */
export async function collectRelativeImports(
  entryFiles: string[],
  rootDir: string,
): Promise<{ insideFiles: string[]; outsideFiles: string[] }> {
  // 用 realpath 规范化 src 绝对路径，兼容 macOS 符号链接（esbuild 传入的路径已是 realpath）
  const appDirAbs = toRealPath(path.resolve(rootDir, 'src'));
  const tsconfig = readTsconfig(rootDir);
  const visited = new Set<string>();
  const insideFiles = new Set<string>();
  const outsideFiles = new Set<string>();

  async function collect(filePath: string): Promise<void> {
    if (visited.has(filePath)) return;
    visited.add(filePath);

    let source: string;
    try {
      source = await fs.promises.readFile(filePath, 'utf8');
    } catch {
      return;
    }

    for (const specifier of extractImportSpecifiers(source)) {
      // 已带产物后缀：运行时 import 的就是产物（或第三方 .js），源码不递归
      if (/\.(js|mjs|cjs)$/.test(specifier)) continue;

      let resolved: string | null;
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        resolved = resolveRelativeSpecifier(filePath, specifier);
      } else if (tsconfig) {
        // 别名 specifier：解析候选目标（相对 rootDir）后探测源文件
        resolved = null;
        for (const candidate of resolveAlias(specifier, tsconfig)) {
          const probed = resolveSpecifierFromDir(rootDir, candidate);
          if (probed) {
            resolved = probed;
            break;
          }
        }
      } else {
        resolved = null;
      }

      if (!resolved) continue;
      // 项目外文件（node_modules / rootDir 外）不收集。
      // 归类判断用 realpath 归一化两侧（tmpdir 符号链接 /var → /private/var 会误判），
      // 但收集结果保留原始解析路径——esbuild 的 outbase 基于调用方传入的 rootDir 形式，
      // entry 路径必须与 outbase 字符串前缀一致，否则产物落入 _.._ 垃圾目录
      if (!isInsideDir(toRealPath(resolved), toRealPath(path.resolve(rootDir)))) continue;

      if (isInsideDir(toRealPath(resolved), appDirAbs)) {
        insideFiles.add(resolved);
      } else {
        outsideFiles.add(resolved);
      }
      await collect(resolved);
    }
  }

  for (const entry of entryFiles) {
    await collect(entry);
  }

  return {
    insideFiles: Array.from(insideFiles),
    outsideFiles: Array.from(outsideFiles),
  };
}
