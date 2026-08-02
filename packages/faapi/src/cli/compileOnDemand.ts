import path from 'node:path';
import fs from 'node:fs';
import { compileDevRoutes } from './compileDevRoutes';
import { generateSchemaFiles } from './generateSchemaFiles';
import { getRuntimeSchemaPath } from './generateSchemaFiles';
import type { RouteManifest } from '../router/routeTypes';

/**
 * 按需编译（Vite 风格）：仅在请求时编译被访问的 handler.ts + 生成 zod.js
 *
 * 设计目标：dev 启动时零编译、零 schema 生成，handler.js / zod.js 首次被需要时才触发。
 * 与阶段 1（scanRoutes 去 import）配合，dev 冷启动近乎瞬开。
 *
 * 四种触发路径：
 * 1. `loadRouteModule` 先调 `ensureCompiled` 编译源码 → 再 import handler.js
 * 2. `loadWsHandler` 同上（WS handler.js）
 * 3. `createServer` 调 `ensureSchemaGenerated` 检查 zod.js 是否存在/最新 → 不存在则生成
 * 4. watcher 文件变化 → 增量编译该文件（保留现有逻辑）+ 删除 stale zod.js
 *
 * mtime 缓存（阶段 4）：
 * - `ensureCompiled`：handler.js 存在且 mtime ≥ 源码 mtime → 跳过编译
 * - `ensureSchemaGenerated`：zod.js 存在且 mtime ≥ 源码 mtime → 跳过生成
 * - 首次调用后写入内存 Set，后续直接跳过（避免 fs.statSync 调用）
 * - watcher 触发时清除内存 Set，mtime 重新评估
 */

/**
 * 比较源文件和产物文件的 mtime
 *
 * @returns true 表示产物是最新的（可复用），false 表示需要重新生成
 */
function isProductFresh(sourceAbsPath: string, productAbsPath: string): boolean {
  try {
    const srcStat = fs.statSync(sourceAbsPath);
    const prodStat = fs.statSync(productAbsPath);
    return prodStat.mtimeMs >= srcStat.mtimeMs;
  } catch {
    return false;
  }
}

// ─── handler.js 按需编译 ────────────────────────────────────────────

/**
 * 编译状态缓存：源文件绝对路径 → 是否已按需编译过
 *
 * 用于避免重复编译同一文件（首次请求编译后，后续请求命中缓存跳过编译）。
 * watcher 文件变化时通过 clearCompiledFiles 清除全部条目（reloadRoutes 统一处理）。
 */
const compiledFiles = new Set<string>();

/**
 * 清空所有按需编译缓存（reloadRoutes 时调用）
 */
export function clearCompiledFiles(): void {
  compiledFiles.clear();
}

/**
 * 确保源文件已编译为产物，未编译则触发单文件编译
 *
 * 调用方（`loadRouteModule` / `loadWsHandler`）在 import 产物之前调用此函数，确保产物已生成。
 *
 * mtime 缓存（阶段 4）：
 * 1. 内存 Set 命中 → 跳过（最快路径）
 * 2. 产物存在且 mtime ≥ 源码 mtime → 跳过（复用已有产物，如 watcher 已编译）
 * 3. 产物不存在或 stale → 编译 → 加入内存 Set
 *
 * @param sourceAbsPath 源码 .ts 绝对路径
 * @param rootDir 项目根目录
 * @param dist 产物目录（dev 模式为 '.faapi'）
 * @returns 是否实际触发了编译（false 表示已编译过或产物已最新或源文件不存在）
 * @throws 编译失败时抛错（带原始 cause），调用方可据此给出精确错误信息
 */
export async function ensureCompiled(
  sourceAbsPath: string,
  rootDir: string,
  dist: string,
): Promise<boolean> {
  // 内存缓存命中：跳过
  if (compiledFiles.has(sourceAbsPath)) {
    return false;
  }

  // 源文件不存在：无法编译
  if (!fs.existsSync(sourceAbsPath)) {
    return false;
  }

  // mtime 缓存：产物已存在且最新 → 复用（watcher 已编译过的情况）
  const productPath = prodSourcePathToProductPath(sourceAbsPath, rootDir, dist);
  if (productPath && isProductFresh(sourceAbsPath, productPath)) {
    compiledFiles.add(sourceAbsPath);
    return false;
  }

  // 编译失败时抛错（不吞错误），让调用方拿到原始 cause
  await compileDevRoutes({
    rootDir,
    dist,
    files: [sourceAbsPath],
    logLevel: 'silent',
  });
  compiledFiles.add(sourceAbsPath);
  return true;
}

/**
 * 从源码绝对路径推算产物绝对路径
 *
 * 源码 `<rootDir>/src/api/hello/handler.ts` → 产物 `<rootDir>/<dist>/api/hello/handler.js`
 */
function prodSourcePathToProductPath(
  sourceAbsPath: string,
  rootDir: string,
  dist: string,
): string | null {
  const rel = path.relative(rootDir, sourceAbsPath).replace(/\\/g, '/');
  if (!rel.startsWith('src/')) return null;
  const relWithoutSrc = rel.slice(4); // 去掉 src/
  const jsRel = relWithoutSrc.replace(/\.ts$/, '.js');
  return path.resolve(rootDir, dist, jsRel);
}

// ─── zod.js 按需生成 ────────────────────────────────────────────────

/**
 * schema 生成状态缓存：schemaPath → 是否已按需生成过
 *
 * 与 compiledFiles 类似，避免重复生成 zod.js。
 * watcher 触发时通过 clearGeneratedSchemas 清除。
 */
const generatedSchemas = new Set<string>();

/**
 * 清空所有 schema 生成缓存（reloadRoutes 时调用）
 */
export function clearGeneratedSchemas(): void {
  generatedSchemas.clear();
}

/**
 * 确保 zod.js 已生成，未生成则触发单文件 schema 生成
 *
 * 调用方（createServer）在 validateInput 之前调用此函数。
 *
 * route.filePath 在 dev/prod 模式下均为产物路径（如 '.faapi/api/hello/handler.js'），
 * 需通过 prodPathToSourcePath 反推源码 .ts 路径用于 AST 分析和 mtime 比较。
 *
 * mtime 缓存（阶段 4）：
 * 1. 内存 Set 命中 → 跳过
 * 2. zod.js 存在且 mtime ≥ 源码 mtime → 跳过（复用已有产物）
 * 3. zod.js 不存在或 stale → 生成 → 加入内存 Set
 *
 * @param schemaPath zod.js 绝对路径
 * @param routeFilePath route.filePath（产物路径，如 '.faapi/api/hello/handler.js'）
 * @param routes 完整路由清单（用于过滤同文件的所有方法）
 * @param rootDir 项目根目录
 * @param dist 产物目录
 * @returns 是否实际触发了生成（false 表示已生成过或产物已最新或源文件不存在）
 * @throws schema 生成失败时抛错（带原始 cause），由 createServer 错误处理链接管
 */
export async function ensureSchemaGenerated(
  schemaPath: string,
  routeFilePath: string,
  routes: RouteManifest,
  rootDir: string,
  dist: string,
): Promise<boolean> {
  // 内存缓存命中：跳过
  if (generatedSchemas.has(schemaPath)) {
    return false;
  }

  // route.filePath 是产物路径，反推源码绝对路径（用于 mtime 比较和 AST 分析）
  const prodAbsPath = path.resolve(rootDir, routeFilePath);
  const sourceAbsPath = prodPathToSourcePath(prodAbsPath, rootDir, dist);
  if (!fs.existsSync(sourceAbsPath)) {
    return false;
  }

  // mtime 缓存：zod.js 已存在且最新 → 复用
  if (isProductFresh(sourceAbsPath, schemaPath)) {
    generatedSchemas.add(schemaPath);
    return false;
  }

  // 过滤同文件的所有路由（一个 handler.ts 可能有 GET/POST/WS 多个方法）
  const fileRoutes = routes.filter((r) => r.filePath === routeFilePath);
  if (fileRoutes.length === 0) {
    return false;
  }

  // 把产物 filePath 转为源码 filePath（generateSchemaFiles → collectRouteSchemaSources
  // 需要源码 .ts 路径做 AST 分析）
  const sourceRelPath = path.relative(rootDir, sourceAbsPath).replace(/\\/g, '/');
  const sourceRoutes = fileRoutes.map((r) => ({ ...r, filePath: sourceRelPath }));

  // 生成失败时抛错（不吞错误），由 createServer 错误处理链接管
  await generateSchemaFiles(sourceRoutes, rootDir, dist);
  generatedSchemas.add(schemaPath);
  return true;
}

/**
 * 删除指定路由清单对应的所有 zod.js 文件（reloadRoutes 时调用）
 *
 * watcher 文件变化后，旧 zod.js 可能 stale（类型引用变化等）。
 * 删除后下次请求触发 ensureSchemaGenerated 重新生成。
 *
 * 仅删除文件，不删除目录（faapi-helpers.js 保留，内容确定性不变）。
 */
export async function deleteSchemaFiles(
  routes: RouteManifest,
  rootDir: string,
  dist: string,
): Promise<void> {
  const deleted = new Set<string>();
  for (const route of routes) {
    const schemaPath = getRuntimeSchemaPath(route.filePath, dist, rootDir);
    if (deleted.has(schemaPath)) continue;
    deleted.add(schemaPath);
    try {
      await fs.promises.unlink(schemaPath);
    } catch {
      // 文件不存在：忽略
    }
  }
}

// ─── 路径转换 ────────────────────────────────────────────────────────

/**
 * 从产物绝对路径反推源码绝对路径
 *
 * 产物路径形如 `<rootDir>/<dist>/api/hello/handler.js`，
 * 源码路径形如 `<rootDir>/src/api/hello/handler.ts`。
 *
 * 反推规则：
 * 1. 去掉 `<dist>/` 前缀
 * 2. 加 `src/` 前缀
 * 3. `.js` → `.ts`（如果 .ts 不存在则保持 .js）
 *
 * @param prodAbsPath 产物绝对路径
 * @param rootDir 项目根目录
 * @param dist 产物目录
 * @returns 源码绝对路径（.ts 优先，.js 兜底）
 */
export function prodPathToSourcePath(prodAbsPath: string, rootDir: string, dist: string): string {
  const rel = path.relative(rootDir, prodAbsPath).replace(/\\/g, '/');
  // 去掉 <dist>/ 前缀
  let relWithoutDist = rel;
  if (relWithoutDist.startsWith(`${dist}/`)) {
    relWithoutDist = relWithoutDist.slice(dist.length + 1);
  }
  // 加 src/ 前缀
  const srcRel = `src/${relWithoutDist}`;
  // .js → .ts（.ts 不存在时回退 .js）
  const tsRel = srcRel.replace(/\.js$/, '.ts');
  const tsAbs = path.resolve(rootDir, tsRel);
  if (fs.existsSync(tsAbs)) return tsAbs;
  // .ts 不存在，保持 .js（极少见，可能是用户直接放 .js 源码）
  return path.resolve(rootDir, srcRel);
}

// ─── Dev 按需模式标记 ────────────────────────────────────────────────

/**
 * Dev 按需编译模式标记
 *
 * 由 devCommand 在按需模式启动时设置为 true，loadRouteModule / loadWsHandler /
 * createServer 通过此标记判断是否启用按需编译/schema 生成回退。
 *
 * prod 模式（node dist/main）始终为 false——产物在 build 阶段已固化，import 失败即报错。
 */
let devOnDemandEnabled = false;

export function setDevOnDemandEnabled(enabled: boolean): void {
  devOnDemandEnabled = enabled;
}

export function isDevOnDemandEnabled(): boolean {
  return devOnDemandEnabled;
}

/**
 * Dev 模式产物目录（仅 devOnDemandEnabled 时使用）
 *
 * 由 devCommand 设置，loadRouteModule / loadWsHandler / createServer 通过 getDevDist() 读取。
 */
let devDistDir: string | undefined;

export function setDevDist(dist: string): void {
  devDistDir = dist;
}

export function getDevDist(): string | undefined {
  return devDistDir;
}
