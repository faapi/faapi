import type { HttpMethod } from '../router/constants';
import { resolveExport } from './resolveExports';
import { validateRouteModule } from './validateRouteModule';
import { importWithCacheBust } from '../utils/importWithCacheBust';

export interface RouteModule {
  handler: (...args: unknown[]) => unknown;
  method: HttpMethod;
}

/**
 * 动态 import 路由文件并提取 handler
 * @param filePath 路由文件的绝对路径
 * @param method HTTP 方法名（也是导出名）
 */
export async function loadRouteModule(filePath: string, method: HttpMethod): Promise<RouteModule> {
  let module: Record<string, unknown>;
  try {
    module = await importWithCacheBust(filePath);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load route module "${filePath}": ${reason}`, { cause: err });
  }

  const handler = resolveExport(module, method);
  validateRouteModule(handler, method, filePath);

  return { handler, method };
}
