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
 *
 * 并发去重（mutex）：
 * - 同一文件的并发编译请求会共享同一个 in-flight Promise，避免重复触发 esbuild
 * - 同一 schemaPath 的并发生成请求同理
 * - watcher 触发 clear 时同步清空 in-flight Map
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

// ─── DevOnDemand 状态封装 ────────────────────────────────────────────

/**
 * 按需编译运行时状态
 *
 * 封装原本散落的 4 个模块级可变状态 + 2 个 mutex Map,避免全局污染 +
 * 便于测试隔离(_resetDevOnDemandState 重置回初始状态)。
 *
 * faapi 单进程单 server 设计下,单例 state 已足够。多实例测试场景通过
 * _resetDevOnDemandState 在 beforeEach / afterEach 中清空状态。
 */
interface DevOnDemandState {
  /** 是否启用 dev 按需编译模式（prod 始终 false） */
  enabled: boolean;
  /** dev 模式产物目录（仅 enabled 时使用） */
  distDir: string | undefined;
  /** 已编译文件缓存（源码绝对路径） */
  compiledFiles: Set<string>;
  /** 已生成 schema 缓存（schemaPath 绝对路径） */
  generatedSchemas: Set<string>;
  /** handler.js 编译 mutex：同一 sourceAbsPath 的并发请求共享同一 Promise */
  inFlightCompilations: Map<string, Promise<void>>;
  /** zod.js 生成 mutex：同一 schemaPath 的并发请求共享同一 Promise */
  inFlightSchemaGenerations: Map<string, Promise<void>>;
}

function createDevOnDemandState(): DevOnDemandState {
  return {
    enabled: false,
    distDir: undefined,
    compiledFiles: new Set(),
    generatedSchemas: new Set(),
    inFlightCompilations: new Map(),
    inFlightSchemaGenerations: new Map(),
  };
}

const state: DevOnDemandState = createDevOnDemandState();

/**
 * 重置 dev on demand 状态（仅测试用）
 *
 * 清空所有缓存 + mutex + 标记位,让下一次测试从干净状态开始。
 * 生产代码不应调用此函数——会丢失已编译产物的缓存。
 */
export function _resetDevOnDemandState(): void {
  state.enabled = false;
  state.distDir = undefined;
  state.compiledFiles.clear();
  state.generatedSchemas.clear();
  state.inFlightCompilations.clear();
  state.inFlightSchemaGenerations.clear();
}

// ─── handler.js 按需编译 ────────────────────────────────────────────

/**
 * 清空所有按需编译缓存（reloadRoutes 时调用）
 *
 * 同时清空 in-flight mutex Map，避免 watcher 重置后旧 Promise 永久阻塞。
 */
export function clearCompiledFiles(): void {
  state.compiledFiles.clear();
  state.inFlightCompilations.clear();
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
 * 并发去重（mutex）：
 * - 同一 sourceAbsPath 的并发请求共享同一 in-flight Promise
 * - 第二个请求 await 后返回 false（表示「别的请求已触发编译,本次不需要再触发」）
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
  // mutex: 同一文件正在被别的请求编译 → 等待并返回 false
  const inFlight = state.inFlightCompilations.get(sourceAbsPath);
  if (inFlight) {
    await inFlight.catch(() => {
      // 别的请求编译失败时不在这里抛——让本请求按正常流程自己重试
    });
    return false;
  }

  // 内存缓存命中：跳过
  if (state.compiledFiles.has(sourceAbsPath)) {
    return false;
  }

  // 源文件不存在：无法编译
  if (!fs.existsSync(sourceAbsPath)) {
    return false;
  }

  // mtime 缓存：产物已存在且最新 → 复用（watcher 已编译过的情况）
  const productPath = prodSourcePathToProductPath(sourceAbsPath, rootDir, dist);
  if (productPath && isProductFresh(sourceAbsPath, productPath)) {
    state.compiledFiles.add(sourceAbsPath);
    return false;
  }

  // 触发编译：注册 in-flight Promise 防止并发重复编译
  const compilePromise = (async () => {
    // 编译失败时抛错（不吞错误），让调用方拿到原始 cause
    await compileDevRoutes({
      rootDir,
      dist,
      files: [sourceAbsPath],
      logLevel: 'silent',
    });
    state.compiledFiles.add(sourceAbsPath);
  })();

  state.inFlightCompilations.set(sourceAbsPath, compilePromise);
  try {
    await compilePromise;
    return true;
  } finally {
    state.inFlightCompilations.delete(sourceAbsPath);
  }
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
 * 清空所有 schema 生成缓存（reloadRoutes 时调用）
 *
 * 同时清空 in-flight mutex Map。
 */
export function clearGeneratedSchemas(): void {
  state.generatedSchemas.clear();
  state.inFlightSchemaGenerations.clear();
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
 * 并发去重（mutex）：
 * - 同一 schemaPath 的并发请求共享同一 in-flight Promise
 * - 第二个请求 await 后返回 false
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
  // mutex: 同一 schemaPath 正在被别的请求生成 → 等待并返回 false
  const inFlight = state.inFlightSchemaGenerations.get(schemaPath);
  if (inFlight) {
    await inFlight.catch(() => {
      // 别的请求生成失败时不在这里抛——让本请求按正常流程自己重试
    });
    return false;
  }

  // 内存缓存命中：跳过
  if (state.generatedSchemas.has(schemaPath)) {
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
    state.generatedSchemas.add(schemaPath);
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

  // 触发生成：注册 in-flight Promise 防止并发重复生成
  const generatePromise = (async () => {
    // 生成失败时抛错（不吞错误），由 createServer 错误处理链接管
    await generateSchemaFiles(sourceRoutes, rootDir, dist);
    state.generatedSchemas.add(schemaPath);
  })();

  state.inFlightSchemaGenerations.set(schemaPath, generatePromise);
  try {
    await generatePromise;
    return true;
  } finally {
    state.inFlightSchemaGenerations.delete(schemaPath);
  }
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
export function setDevOnDemandEnabled(enabled: boolean): void {
  state.enabled = enabled;
}

export function isDevOnDemandEnabled(): boolean {
  return state.enabled;
}

/**
 * Dev 模式产物目录（仅 devOnDemandEnabled 时使用）
 *
 * 由 devCommand 设置，loadRouteModule / loadWsHandler / createServer 通过 getDevDist() 读取。
 */
export function setDevDist(dist: string): void {
  state.distDir = dist;
}

export function getDevDist(): string | undefined {
  return state.distDir;
}
