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
 */
export async function loadMiddlewaresFile(filePath: string): Promise<LoadedMiddlewareBundle> {
  try {
    const module = await importWithCacheBust(filePath);

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
  } catch {
    return { middlewares: [], injectors: {} };
  }
}
