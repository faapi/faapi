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
 * 从路由文件所在目录向上逐级查找 middlewares.ts，
 * 按从根到路由目录的顺序合并中间件和注入器（父级在前，子级在后）。
 *
 * 子级中间件包裹父级（洋葱模型下后注册的先执行 after）；
 * 子级注入器覆盖父级同名注入器。
 */
async function findMergedMiddlewares(
  routeFilePath: string,
  rootDir: string,
): Promise<{ middlewares: FaapiMiddleware[]; injectors: InjectorMap } | undefined> {
  const routeDir = path.dirname(routeFilePath);
  const resolvedRoot = path.resolve(rootDir);

  // 收集从根到路由目录的所有 middlewares.{ts,js} 路径
  // dev 模式扫 .ts，start 模式扫 .js（dist 产物）
  const mwPaths: string[] = [];
  let currentDir = path.resolve(rootDir, routeDir);
  while (true) {
    // 优先 .ts（dev），回退 .js（prd dist 产物）
    for (const ext of ['.ts', '.js']) {
      const mwPath = path.join(currentDir, `middlewares${ext}`);
      const absMwPath = path.resolve(rootDir, mwPath);
      if (fs.existsSync(absMwPath)) {
        mwPaths.push(absMwPath);
        break;
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
 * 从 handler.ts 模块中提取导出的 HTTP 方法名
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
 * 检测 handler.ts 模块是否导出 WS 函数
 *
 * WS 导出与 HTTP 方法导出（GET/POST 等）同级，导出名必须为 `WS`。
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
 * @param patterns glob patterns
 * @param appDir app 目录前缀，默认 '.'（项目根目录）；CLI 层默认 'src'，传 undefined 时回退到 '.'
 */
export async function scanRoutes(
  rootDir: string,
  patterns: string[],
  appDir?: string,
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
    // dev 模式扫 .ts，start 模式扫 .js（dist 产物）
    if (fileName === 'handler.ts' || fileName === 'handler.js') {
      const absPath = path.resolve(rootDir, normalizedFile);
      const urlPath = filePathToUrlPath(normalizedFile, dir);
      const paramNames = extractParamNames(urlPath);
      const isDynamic = paramNames.length > 0;
      const isCatchAll = normalizedFile.split('/').some(isCatchAllSegment);
      const middlewareBundle = await findMergedMiddlewares(normalizedFile, rootDir);

      // HTTP 方法导出
      const methods = await extractMethodsFromHandler(absPath);
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
      const hasWs = await hasWsExport(absPath);
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
