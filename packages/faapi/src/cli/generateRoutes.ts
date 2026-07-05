import fs from 'node:fs';
import path from 'node:path';
import type {
  RouteManifest,
  WsRouteManifest,
  RouteRecord,
  WsRouteRecord,
} from '../router/routeTypes';
import type { HttpMethod } from '../router/constants';
import type { FaapiMiddleware } from '../middleware/middlewareTypes';
import type { InjectorMap } from '../middleware/injectorTypes';
import {
  loadMiddlewaresFile,
  getCachedMiddlewares,
  setCachedMiddlewares,
} from '../middleware/loadMiddlewares';
import type { LoadedMiddlewareBundle } from '../middleware/loadMiddlewares';

/**
 * 序列化路由记录（可写入 JS 模块，无函数引用）
 *
 * build 时生成，start 时读取。filePath/middlewarePaths 已转为 prd 形式
 * （打平 appDir 前缀 + prodDir 前缀 + .js）。
 */
export interface SerializedRouteRecord {
  method: HttpMethod;
  urlPath: string;
  filePath: string;
  paramNames: string[];
  isDynamic: boolean;
  isCatchAll?: boolean;
  /** 从根到路由目录的中间件文件绝对路径列表（已排序，根在前） */
  middlewarePaths: string[];
}

export interface SerializedWsRouteRecord {
  urlPath: string;
  filePath: string;
  paramNames: string[];
  isDynamic: boolean;
  isCatchAll?: boolean;
  middlewarePaths: string[];
}

export interface SerializedRouteManifest {
  routes: SerializedRouteRecord[];
  wsRoutes: SerializedWsRouteRecord[];
}

/**
 * 把源码 filePath（src/api/hello/handler.ts）转为产物路径（dist/api/hello/handler.js）
 *
 * 产物结构打平 appDir 前缀：去掉 `src/`，加 prodDir 前缀，.ts → .js。
 *
 * @param filePath 源码相对路径
 * @param appDir app 目录前缀（如 src，'.' 表示无前缀）
 * @param prodDir 产物目录（dist 或 .faapi/dev）
 */
function toProdFilePath(filePath: string, appDir: string, prodDir: string): string {
  let rel = filePath.replace(/\\/g, '/');
  // 去掉 appDir 前缀（打平产物结构）
  if (appDir !== '.' && rel.startsWith(`${appDir}/`)) {
    rel = rel.slice(appDir.length + 1);
  }
  const jsPath = rel.replace(/\.ts$/, '.js');
  return jsPath.startsWith(`${prodDir}/`) ? jsPath : `${prodDir}/${jsPath}`;
}

/**
 * 序列化路由清单为可写入 JS 模块的结构
 *
 * - filePath 转为产物路径（打平 appDir 前缀 + prodDir 前缀 + .js）
 * - middlewares/injectors 不序列化（函数无法序列化），改为 middlewarePaths（中间件文件绝对路径列表）
 * - middlewarePaths 已排序（根在前，路由目录在后），start 时按序加载即可还原洋葱模型
 *
 * @param rootDir 项目根目录
 * @param appDir app 目录前缀（如 src，'.' 表示无前缀）
 * @param prodDir 产物目录（dist 或 .faapi/dev），用于转换 filePath 和查找中间件
 */
export function serializeRoutes(
  routes: RouteManifest,
  wsRoutes: WsRouteManifest,
  rootDir: string,
  appDir: string = 'src',
  prodDir: string = 'dist',
): SerializedRouteManifest {
  const serialize = <T extends RouteRecord | WsRouteRecord>(
    route: T,
  ): T extends RouteRecord ? SerializedRouteRecord : SerializedWsRouteRecord => {
    const middlewarePaths = extractMiddlewarePaths(route.filePath, rootDir, appDir, prodDir);
    const serialized = {
      urlPath: route.urlPath,
      filePath: toProdFilePath(route.filePath, appDir, prodDir),
      paramNames: route.paramNames,
      isDynamic: route.isDynamic,
      isCatchAll: route.isCatchAll,
      middlewarePaths,
    };
    if ('method' in route) {
      (serialized as SerializedRouteRecord).method = (route as RouteRecord).method;
    }
    return serialized as T extends RouteRecord ? SerializedRouteRecord : SerializedWsRouteRecord;
  };

  return {
    routes: routes.map(serialize) as SerializedRouteRecord[],
    wsRoutes: wsRoutes.map(serialize) as SerializedWsRouteRecord[],
  };
}

/**
 * 从路由文件路径，向上查找所有中间件文件绝对路径（根在前，路由目录在后）
 *
 * 与 scanRoutes.findMergedMiddlewares 的收集逻辑一致，但只返回路径不加载。
 * 检查源码形式（.ts）中间件文件是否存在，返回产物形式（.js）绝对路径。
 *
 * @param routeFilePath 源码相对路径（如 src/api/hello/handler.ts）
 * @param rootDir 项目根目录
 * @param appDir app 目录前缀（如 src，'.' 表示无前缀）
 * @param prodDir 产物目录（dist 或 .faapi/dev）
 */
function extractMiddlewarePaths(
  routeFilePath: string,
  rootDir: string,
  appDir: string,
  prodDir: string,
): string[] {
  const routeDir = path.dirname(routeFilePath);
  const resolvedRoot = path.resolve(rootDir);

  const paths: string[] = [];
  let currentDir = path.resolve(rootDir, routeDir);
  while (true) {
    // 检查源码 middlewares.ts 是否存在，回退 middlewares.js（prd 残留场景）
    const mwTsPath = path.join(currentDir, 'middlewares.ts');
    const mwJsPath = path.join(currentDir, 'middlewares.js');
    const absTsPath = path.resolve(rootDir, mwTsPath);
    const absJsPath = path.resolve(rootDir, mwJsPath);
    const absMwPath = fs.existsSync(absTsPath)
      ? absTsPath
      : fs.existsSync(absJsPath)
        ? absJsPath
        : null;
    if (absMwPath) {
      // 转为产物形式绝对路径（打平 appDir 前缀）
      const relMwPath = path.relative(rootDir, absMwPath);
      const prodAbsPath = path.resolve(rootDir, toProdFilePath(relMwPath, appDir, prodDir));
      paths.push(prodAbsPath);
    }
    if (currentDir === resolvedRoot) break;
    // 不超出 appDir 目录（避免向上查到非源码目录）
    // appDir 通常是 src，到达 src 的父目录（rootDir）时停止
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  // paths 是从路由目录向上收集的，需反转为根在前
  paths.reverse();
  return paths;
}

/**
 * 把序列化的路由清单写入 JS 模块
 *
 * 生成 ESM 模块，start 时通过 import() 加载。
 */
export async function writeRoutesModule(
  manifest: SerializedRouteManifest,
  outputPath: string,
): Promise<void> {
  const dir = path.dirname(outputPath);
  await fs.promises.mkdir(dir, { recursive: true });

  // 用 JSON.stringify 嵌入，保证字符串转义安全
  const content = `// 自动生成，请勿手动编辑（faapi build 产物）
export const routes = ${JSON.stringify(manifest.routes, null, 2)};
export const wsRoutes = ${JSON.stringify(manifest.wsRoutes, null, 2)};
`;

  await fs.promises.writeFile(outputPath, content, 'utf-8');
}

/**
 * 从序列化清单水合路由（加载中间件，还原 RouteRecord）
 *
 * start 时调用，对每条路由按 middlewarePaths 加载中间件文件。
 */
export async function hydrateRoutes(
  manifest: SerializedRouteManifest,
): Promise<{ routes: RouteManifest; wsRoutes: WsRouteManifest }> {
  const hydrateRoute = async (serialized: SerializedRouteRecord): Promise<RouteRecord> => {
    const bundle = await loadMiddlewarePaths(serialized.middlewarePaths);
    return {
      method: serialized.method,
      urlPath: serialized.urlPath,
      filePath: serialized.filePath,
      paramNames: serialized.paramNames,
      isDynamic: serialized.isDynamic,
      isCatchAll: serialized.isCatchAll,
      middlewares: bundle?.middlewares,
      injectors: bundle?.injectors,
    };
  };

  const hydrateWsRoute = async (serialized: SerializedWsRouteRecord): Promise<WsRouteRecord> => {
    const bundle = await loadMiddlewarePaths(serialized.middlewarePaths);
    return {
      urlPath: serialized.urlPath,
      filePath: serialized.filePath,
      paramNames: serialized.paramNames,
      isDynamic: serialized.isDynamic,
      isCatchAll: serialized.isCatchAll,
      middlewares: bundle?.middlewares,
      injectors: bundle?.injectors,
    };
  };

  const routes = await Promise.all(manifest.routes.map(hydrateRoute));
  const wsRoutes = await Promise.all(manifest.wsRoutes.map(hydrateWsRoute));
  return { routes, wsRoutes };
}

/**
 * 按路径列表加载并合并中间件（根在前，路由目录在后）
 *
 * 与 scanRoutes.findMergedMiddlewares 的合并逻辑一致：
 * - 中间件：父级在前，子级追加在后（洋葱模型内层）
 * - 注入器：子级覆盖父级同名
 */
async function loadMiddlewarePaths(
  middlewarePaths: string[],
): Promise<{ middlewares: FaapiMiddleware[]; injectors: InjectorMap } | undefined> {
  if (middlewarePaths.length === 0) return undefined;

  const mergedMiddlewares: FaapiMiddleware[] = [];
  const mergedInjectors: InjectorMap = {};

  for (const absMwPath of middlewarePaths) {
    let bundle: LoadedMiddlewareBundle | undefined = getCachedMiddlewares(absMwPath);
    if (bundle === undefined) {
      bundle = await loadMiddlewaresFile(absMwPath);
      setCachedMiddlewares(absMwPath, bundle);
    }
    mergedMiddlewares.push(...bundle.middlewares);
    for (const [name, injector] of Object.entries(bundle.injectors)) {
      mergedInjectors[name] = injector;
    }
  }

  return { middlewares: mergedMiddlewares, injectors: mergedInjectors };
}
