import type { FaapiMiddleware } from './middlewareTypes';
import type { InjectorMap } from './injectorTypes';
import { importWithCacheBust } from '../utils/importWithCacheBust';

/**
 * 中间件 + 注入器加载结果
 */
export interface LoadedMiddlewareBundle {
  middlewares: FaapiMiddleware[];
  injectors: InjectorMap;
}

/**
 * 中间件缓存，key 为 middlewares.ts 的绝对路径
 */
const middlewareCache = new Map<string, LoadedMiddlewareBundle>();

/**
 * in-flight 加载去重：同一文件并发首载共享同一 Promise（冷启动并发首请求
 * 不重复 import + 合并）。invalidateMiddlewareCache 时一并清空
 */
const inFlight = new Map<string, Promise<LoadedMiddlewareBundle>>();

/**
 * 失效所有中间件缓存（watch 模式下文件变化时调用）
 */
export function invalidateMiddlewareCache(): void {
  middlewareCache.clear();
  inFlight.clear();
}

/**
 * 从缓存中读取中间件 bundle（未命中返回 undefined）
 */
export function getCachedMiddlewares(absPath: string): LoadedMiddlewareBundle | undefined {
  return middlewareCache.get(absPath);
}

/**
 * 写入中间件缓存
 */
export function setCachedMiddlewares(absPath: string, bundle: LoadedMiddlewareBundle): void {
  middlewareCache.set(absPath, bundle);
}

/**
 * 从绝对路径加载 middlewares.ts 并校验
 *
 * 文件可导出：
 * - `default`：中间件数组（洋葱模型，每项为 async 函数）
 * - `injectors`：注入器映射表（按参数名匹配 handler 参数）
 *
 * 两者都是可选的，但至少要有一个。
 *
 * 错误口径（不降级）：加载/校验失败显式抛错，不返回空 bundle——空 bundle 让服务
 * 带病运行（鉴权/CORS 中间件静默失效后请求绕过横切能力直接命中 handler），比
 * 命中路由显式 500（onError 可感知）更危险。dev 下 watcher 修复后 reloadRoutes 自愈。
 */
export async function loadMiddlewaresFile(filePath: string): Promise<LoadedMiddlewareBundle> {
  const module = (await importWithCacheBust(filePath)) as Record<string, unknown>;

  // 加载中间件数组
  const middlewares = (module.default ?? module.middlewares ?? []) as unknown[];
  if (!Array.isArray(middlewares)) {
    throw new TypeError(
      `[faapi] middlewares.ts must export an array (default or named "middlewares"): ${filePath}`,
    );
  }

  const validMiddlewares: FaapiMiddleware[] = [];
  for (const m of middlewares) {
    if (typeof m !== 'function') {
      throw new TypeError(
        `[faapi] every middleware must be a function, got ${typeof m}: ${filePath}`,
      );
    }
    validMiddlewares.push(m as FaapiMiddleware);
  }

  // 加载注入器映射表（可选命名导出）
  const injectors = (module.injectors ?? {}) as InjectorMap;
  if (typeof injectors !== 'object' || injectors === null) {
    throw new TypeError(`[faapi] "injectors" export must be an object: ${filePath}`);
  }

  const validInjectors: InjectorMap = {};
  for (const [name, injector] of Object.entries(injectors)) {
    if (typeof injector !== 'function') {
      throw new TypeError(`[faapi] injector "${name}" must be a function: ${filePath}`);
    }
    validInjectors[name] = injector;
  }

  return { middlewares: validMiddlewares, injectors: validInjectors };
}

/**
 * 按路径列表加载并合并中间件（根在前，路由目录在后）
 *
 * 合并语义：
 * - 子级中间件追加在父级之后（洋葱模型：后注册的中间件在内层）
 * - 子级注入器覆盖父级同名注入器
 *
 * 单文件加载带缓存（getCachedMiddlewares/setCachedMiddlewares），重复调用仅首次真正加载。
 *
 * @param middlewarePaths 中间件文件绝对路径列表（根在前，路由目录在后）
 * @returns 合并后的中间件+注入器；无中间件时返回 undefined
 */
export async function loadMergedMiddlewares(
  middlewarePaths: string[],
): Promise<LoadedMiddlewareBundle | undefined> {
  if (middlewarePaths.length === 0) return undefined;

  const mergedMiddlewares: FaapiMiddleware[] = [];
  const mergedInjectors: InjectorMap = {};

  for (const absMwPath of middlewarePaths) {
    let bundle: LoadedMiddlewareBundle | undefined = getCachedMiddlewares(absMwPath);
    if (bundle === undefined) {
      // in-flight 去重：并发首载共享同一 Promise（对照 compileOnDemand 的 mutex 模式）
      let loading = inFlight.get(absMwPath);
      if (!loading) {
        loading = loadMiddlewaresFile(absMwPath).then(
          (result) => {
            setCachedMiddlewares(absMwPath, result);
            return result;
          },
          (err) => {
            // 加载失败不缓存（内存与 in-flight 均不缓存失败结果）——下次请求重试加载
            inFlight.delete(absMwPath);
            throw err;
          },
        );
        inFlight.set(absMwPath, loading);
      }
      bundle = await loading;
    }
    mergedMiddlewares.push(...bundle.middlewares);
    for (const [name, injector] of Object.entries(bundle.injectors)) {
      mergedInjectors[name] = injector;
    }
  }

  if (mergedMiddlewares.length === 0 && Object.keys(mergedInjectors).length === 0) {
    return undefined;
  }

  return { middlewares: mergedMiddlewares, injectors: mergedInjectors };
}
