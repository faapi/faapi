import fg from 'fast-glob';
import path from 'node:path';
import fs from 'node:fs';
import type { RouteManifest, WsRouteManifest } from './routeTypes';
import { isHttpMethod, type HttpMethod } from './constants';
import { filePathToUrlPath, extractParamNames, isCatchAllSegment } from './parseRouteFile';
import {
  loadMiddlewaresFile,
  getCachedMiddlewares,
  setCachedMiddlewares,
  type LoadedMiddlewareBundle,
} from '../middleware/loadMiddlewares';
import type { FaapiMiddleware } from '../middleware/middlewareTypes';
import type { InjectorMap } from '../middleware/injectorTypes';
import { importWithCacheBust } from '../utils/importWithCacheBust';

/**
 * 把源码绝对路径转为产物绝对路径（用于 import 产物 .js）
 *
 * dev/build 模式下 scanRoutes 不再 import 源码 .ts（无需 tsx），
 * 而是先编译到 prodDir（.faapi/dev 或 dist），再 import 产物 .js。
 *
 * @param sourceAbsPath 源码绝对路径（如 /root/src/api/hello/handler.ts）
 * @param rootDir 项目根目录
 * @param prodDir 产物目录（dist 或 .faapi/dev）
 */
function toProdAbsPath(sourceAbsPath: string, rootDir: string, prodDir: string): string {
  const rel = path.relative(rootDir, sourceAbsPath);
  const prodRel = `${prodDir}/${rel.replace(/\.ts$/, '.js')}`;
  return path.resolve(rootDir, prodRel);
}

/**
 * 从路由文件所在目录向上逐级查找 middlewares.ts（源码），
 * 按从根到路由目录的顺序合并中间件和注入器（父级在前，子级在后）。
 *
 * 若传入 prodDir，加载产物 middlewares.js（已编译）；否则加载源码 middlewares.ts。
 *
 * 子级中间件包裹父级（洋葱模型下后注册的先执行 after）；
 * 子级注入器覆盖父级同名注入器。
 */
async function findMergedMiddlewares(
  routeFilePath: string,
  rootDir: string,
  prodDir?: string,
): Promise<{ middlewares: FaapiMiddleware[]; injectors: InjectorMap } | undefined> {
  const routeDir = path.dirname(routeFilePath);
  const resolvedRoot = path.resolve(rootDir);

  // 收集从根到路由目录的所有 middlewares 路径
  // prodDir 传入时查找产物 middlewares.js；否则查找源码 middlewares.ts（兼容旧路径）
  const mwPaths: string[] = [];
  let currentDir = path.resolve(rootDir, routeDir);
  while (true) {
    if (prodDir) {
      // 新模式：查找产物 middlewares.js
      const mwPath = path.join(currentDir, 'middlewares.js');
      const absMwPath = path.resolve(rootDir, mwPath);
      // 产物路径：把源码路径转为产物路径
      const prodAbsMwPath = toProdAbsPath(absMwPath, rootDir, prodDir);
      if (fs.existsSync(prodAbsMwPath)) {
        mwPaths.push(prodAbsMwPath);
      }
    } else {
      // 旧模式：查找源码 middlewares.ts/.js
      for (const ext of ['.ts', '.js']) {
        const mwPath = path.join(currentDir, `middlewares${ext}`);
        const absMwPath = path.resolve(rootDir, mwPath);
        if (fs.existsSync(absMwPath)) {
          mwPaths.push(absMwPath);
          break;
        }
      }
    }
    if (currentDir === resolvedRoot) break;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  if (mwPaths.length === 0) return undefined;

  // 从根到路由目录逐级加载（mwPaths 是从路由目录向上收集的，需反转）
  mwPaths.reverse();

  const mergedMiddlewares: FaapiMiddleware[] = [];
  const mergedInjectors: InjectorMap = {};

  for (const absMwPath of mwPaths) {
    let bundle: LoadedMiddlewareBundle | undefined = getCachedMiddlewares(absMwPath);
    if (bundle === undefined) {
      bundle = await loadMiddlewaresFile(absMwPath);
      setCachedMiddlewares(absMwPath, bundle);
    }
    // 子级中间件追加在父级之后（洋葱模型：后注册的中间件在内层）
    mergedMiddlewares.push(...bundle.middlewares);
    // 子级注入器覆盖父级同名注入器
    for (const [name, injector] of Object.entries(bundle.injectors)) {
      mergedInjectors[name] = injector;
    }
  }

  if (mergedMiddlewares.length === 0 && Object.keys(mergedInjectors).length === 0) {
    return undefined;
  }

  return { middlewares: mergedMiddlewares, injectors: mergedInjectors };
}

/**
 * 从 handler 模块中提取导出的 HTTP 方法名
 *
 * @param absPath handler 文件路径（产物 .js 或源码 .ts，取决于调用方）
 */
export async function extractMethodsFromHandler(absPath: string): Promise<HttpMethod[]> {
  try {
    const module = await importWithCacheBust(absPath);
    const methods: HttpMethod[] = [];
    for (const key of Object.keys(module)) {
      if (isHttpMethod(key) && typeof module[key] === 'function') {
        methods.push(key);
      }
    }
    return methods;
  } catch (err) {
    // 模块加载失败时输出警告，避免静默吞没错误
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[faapi] 加载路由文件失败 ${absPath}: ${reason}`);
    return [];
  }
}

/**
 * 检测 handler 模块是否导出 WS 函数
 *
 * WS 导出与 HTTP 方法导出（GET/POST 等）同级，导出名必须为 `WS`。
 *
 * @param absPath handler 文件路径（产物 .js 或源码 .ts，取决于调用方）
 */
export async function hasWsExport(absPath: string): Promise<boolean> {
  try {
    const module = await importWithCacheBust(absPath);
    return typeof module['WS'] === 'function';
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[faapi] 加载路由文件失败（WS 检测）${absPath}: ${reason}`);
    return false;
  }
}

/**
 * 扫描 api 目录，同时生成 HTTP 路由清单和 WebSocket 路由清单
 *
 * 路由文件格式：handler.ts，导出 HTTP 方法名作为 handler，也可导出 `WS` 函数声明 WebSocket 路由
 * ```ts
 * // api/user/handler.ts
 * export function GET() { return { list: [] } }
 * export function POST(body: any) { return { created: true } }
 *
 * // WebSocket 路由：导出 WS 函数
 * export function WS(ctx: WsContext) {
 *   return { onMessage(ws, msg) { ws.send(`echo: ${msg}`) } };
 * }
 * ```
 * 一个 handler.ts 可同时导出 HTTP 方法（GET/POST...）和 WS 函数，
 * 分别生成 HTTP RouteRecord 和 WsRouteRecord。
 *
 * @param rootDir 项目根目录
 * @param patterns glob patterns（源码 .ts 路径，如 src/api 下所有 .ts）
 * @param appDir app 目录前缀，默认 '.'（项目根目录）；CLI 层默认 'src'
 * @param prodDir 产物目录（dist 或 .faapi/dev）。传入时 import 产物 .js（不依赖 tsx）；
 *                不传时 import 源码 .ts（旧模式，需要 tsx）。
 */
export async function scanRoutes(
  rootDir: string,
  patterns: string[],
  appDir?: string,
  prodDir?: string,
): Promise<{ routes: RouteManifest; wsRoutes: WsRouteManifest }> {
  const dir = appDir ?? '.';

  const files = await fg(patterns, {
    cwd: rootDir,
    onlyFiles: true,
    absolute: false,
  });

  const routes: RouteManifest = [];
  const wsRoutes: WsRouteManifest = [];

  for (const file of files) {
    const normalizedFile = file.replace(/\\/g, '/');
    const fileName = normalizedFile.split('/').pop()!;

    // 处理 handler.{ts,js} — API 路由 + WebSocket 路由
    // dev/build 模式扫源码 .ts（prodDir 传入），start 模式扫产物 .js（由 hydrateRoutes 处理）
    if (fileName === 'handler.ts' || fileName === 'handler.js') {
      const absPath = path.resolve(rootDir, normalizedFile);
      // prodDir 传入时 import 产物 .js；否则 import 源码 .ts
      const importPath = prodDir ? toProdAbsPath(absPath, rootDir, prodDir) : absPath;
      const urlPath = filePathToUrlPath(normalizedFile, dir);
      const paramNames = extractParamNames(urlPath);
      const isDynamic = paramNames.length > 0;
      const isCatchAll = normalizedFile.split('/').some(isCatchAllSegment);
      const middlewareBundle = await findMergedMiddlewares(normalizedFile, rootDir, prodDir);

      // HTTP 方法导出
      const methods = await extractMethodsFromHandler(importPath);
      for (const method of methods) {
        routes.push({
          method,
          urlPath,
          filePath: normalizedFile,
          paramNames,
          isDynamic,
          isCatchAll: isCatchAll || undefined,
          middlewares: middlewareBundle?.middlewares,
          injectors: middlewareBundle?.injectors,
        });
      }

      // WS 导出
      const hasWs = await hasWsExport(importPath);
      if (hasWs) {
        wsRoutes.push({
          urlPath,
          filePath: normalizedFile,
          paramNames,
          isDynamic,
          isCatchAll: isCatchAll || undefined,
          middlewares: middlewareBundle?.middlewares,
          injectors: middlewareBundle?.injectors,
        });
      }
      continue;
    }
  }

  return { routes, wsRoutes };
}
