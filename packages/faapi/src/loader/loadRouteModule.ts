import type { HttpMethod } from '../router/constants';
import { resolveExport } from './resolveExports';
import { validateRouteModule } from './validateRouteModule';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import {
  ensureCompiled,
  isDevOnDemandEnabled,
  getDevDist,
  prodPathToSourcePath,
} from '../cli/compileOnDemand';

export interface RouteModule {
  handler: (...args: unknown[]) => unknown;
  method: HttpMethod;
}

/**
 * 动态 import 路由文件并提取 handler
 *
 * Dev 按需编译模式（Vite 风格）：首次 import 失败时触发单文件编译，编译后重试 import。
 * Prod 模式：产物在 build 阶段已固化，import 失败直接抛错。
 *
 * 错误传递：
 * - import 失败 + 编译成功 → 重试 import（编译错误不会抛出）
 * - import 失败 + 编译失败 → 抛出编译错误（比 import 错误更精确，因为编译错误才是根本原因）
 * - import 失败 + 非按需模式 → 抛出 import 错误
 *
 * @param filePath 路由文件的绝对路径
 * @param method HTTP 方法名（也是导出名）
 * @param rootDir 项目根目录（按需编译模式用，可选）
 */
export async function loadRouteModule(
  filePath: string,
  method: HttpMethod,
  rootDir?: string,
): Promise<RouteModule> {
  let module: Record<string, unknown>;
  try {
    module = await importWithCacheBust(filePath);
  } catch (err: unknown) {
    // Dev 按需编译模式：import 失败时尝试编译源码后重试
    if (isDevOnDemandEnabled() && rootDir) {
      const dist = getDevDist();
      if (dist) {
        const sourcePath = prodPathToSourcePath(filePath, rootDir, dist);
        try {
          const compiled = await ensureCompiled(sourcePath, rootDir, dist);
          if (compiled) {
            // 编译成功，重试 import
            module = await importWithCacheBust(filePath);
            const handler = resolveExport(module, method);
            validateRouteModule(handler, method, filePath);
            return { handler, method };
          }
        } catch (compileErr) {
          // 编译失败：抛出编译错误（比 import 错误更精确，编译错误才是根本原因）
          const compileReason =
            compileErr instanceof Error ? compileErr.message : String(compileErr);
          throw new Error(`Failed to compile route module "${sourcePath}": ${compileReason}`, {
            cause: compileErr,
          });
        }
      }
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load route module "${filePath}": ${reason}`, { cause: err });
  }

  const handler = resolveExport(module, method);
  validateRouteModule(handler, method, filePath);

  return { handler, method };
}
