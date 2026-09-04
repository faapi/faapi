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
 * Dev 按需编译模式（Vite 风格）：先确保编译再 import，避免 import 不存在的文件。
 * Prod 模式：产物在 build 阶段已固化，直接 import，失败即报错。
 *
 * 错误传递：
 * - 编译失败 → 抛出编译错误（"Failed to compile route module"）
 * - import 失败 → 抛出加载错误（"Failed to load route module"）
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
  // Dev 按需模式：先确保编译再 import
  // 避免"import 失败 → 编译 → 重试 import"模式——首次 import 不存在的文件会污染
  // Vite SSR 内部状态，导致编译创建文件后重试 import 仍失败（CI Linux 上复现）
  //
  // 不在此处 existsSync(sourcePath)：ensureCompiled 内部对缺失源文件直接返回 false,
  // 外层检查是冗余的每请求同步 IO（编译完成一次后内存 Set 命中即短路）
  if (isDevOnDemandEnabled() && rootDir) {
    const dist = getDevDist();
    if (dist) {
      const sourcePath = prodPathToSourcePath(filePath, rootDir, dist);
      if (sourcePath) {
        try {
          await ensureCompiled(sourcePath, rootDir, dist);
        } catch (compileErr) {
          const reason = compileErr instanceof Error ? compileErr.message : String(compileErr);
          throw new Error(`Failed to compile route module "${sourcePath}": ${reason}`, {
            cause: compileErr,
          });
        }
      }
    }
  }

  // import 模块（dev 按需模式下走 Node 原生 import 绕过 Vite SSR 缓存）
  let module: Record<string, unknown>;
  try {
    module = await importWithCacheBust(filePath, isDevOnDemandEnabled());
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load route module "${filePath}": ${reason}`, { cause: err });
  }

  const handler = resolveExport(module, method);
  validateRouteModule(handler, method, filePath);

  return { handler, method };
}
