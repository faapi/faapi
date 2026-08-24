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
 * 失效所有中间件缓存（watch 模式下文件变化时调用）
 */
export function invalidateMiddlewareCache(): void {
  middlewareCache.clear();
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
 * 加载失败时的语义：
 * - 文件 import 抛错（语法错误 / 路径不存在 / 运行时抛错）→ console.error 输出原始错误,
 *   返回空 bundle,确保服务仍可启动而非崩溃。鉴权等关键中间件失效后业务可由 onError 感知。
 *   开发期 watcher 会因 reloadRoutes 触发重新加载,实现自愈。
 */
export async function loadMiddlewaresFile(filePath: string): Promise<LoadedMiddlewareBundle> {
  let module: Record<string, unknown>;
  try {
    module = (await importWithCacheBust(filePath)) as Record<string, unknown>;
  } catch (err) {
    // 关键可见性：必须打印原始错误,否则业务方完全无感知（鉴权中间件失效等同于裸奔）
    console.error(
      `[faapi] Failed to load middlewares from ${filePath}:`,
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    return { middlewares: [], injectors: {} };
  }

  // 加载中间件数组
  const middlewares = (module.default ?? module.middlewares ?? []) as unknown[];
  if (!Array.isArray(middlewares)) {
    console.warn(`[faapi] middlewares.ts 应导出数组，已忽略: ${filePath}`);
    return { middlewares: [], injectors: {} };
  }

  const validMiddlewares = middlewares.filter((m: unknown) => {
    if (typeof m !== 'function') {
      console.warn(`[faapi] 无效的中间件项（应为函数），已忽略: ${typeof m}`);
      return false;
    }
    return true;
  }) as FaapiMiddleware[];

  // 加载注入器映射表（可选命名导出）
  const injectors = (module.injectors ?? {}) as InjectorMap;
  if (typeof injectors !== 'object' || injectors === null) {
    console.warn(`[faapi] injectors 应导出对象，已忽略: ${filePath}`);
    return { middlewares: validMiddlewares, injectors: {} };
  }

  // 校验注入器：每个值必须是函数
  const validInjectors: InjectorMap = {};
  for (const [name, injector] of Object.entries(injectors)) {
    if (typeof injector !== 'function') {
      console.warn(`[faapi] 注入器 ${name} 应为函数，已忽略`);
      continue;
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
      bundle = await loadMiddlewaresFile(absMwPath);
      setCachedMiddlewares(absMwPath, bundle);
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
