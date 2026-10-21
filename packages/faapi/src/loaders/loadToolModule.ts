import fs from 'node:fs';
import { resolveExport } from './resolveExports';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import {
  ensureCompiled,
  isDevOnDemandEnabled,
  getDevDist,
  prodPathToSourcePath,
} from '../cli/compileOnDemand';

/**
 * 加载后的 tool 模块
 *
 * 与 `RouteModule` 对称——`functionName` 替代 `method`(tool 没有HTTP方法维度)。
 * `handler` 是从模块解析出的 tool 函数,可直接调用。
 */
export interface ToolModule {
  /** tool 函数(已校验为 function 类型) */
  handler: (...args: unknown[]) => unknown;
  /** 源码导出名(如 `getWeather`,用于日志/调试,与 `method` 对应) */
  functionName: string;
}

/**
 * 动态 import tool handler 文件并提取指定函数名的导出
 *
 * Dev 按需编译模式(Vite 风格):先 `ensureCompiled` 确保产物存在再 import,
 * 避免 import 不存在的文件污染 Vite SSR 内部状态(详见 [loadRouteModule](./loadRouteModule.md))。
 * Prod 模式:产物在 build 阶段已固化,直接 import,失败即报错。
 *
 * 错误传递:
 * - 编译失败 → 抛 "Failed to compile tool module"
 * - import 失败 → 抛 "Failed to load tool module"
 * - 导出不是函数 → 抛 "does not export a valid function"
 *
 * @param filePath tool handler 文件的绝对路径(产物形式,如 `dist/tools/weather/handler.js`)
 * @param functionName 源码导出函数名(如 `getWeather`,由 `ToolManifest.functionName` 提供)
 * @param rootDir 项目根目录(按需编译模式用,可选)
 */
export async function loadToolModule(
  filePath: string,
  functionName: string,
  rootDir?: string,
): Promise<ToolModule> {
  // Dev 按需模式:先确保编译再 import
  // 避免"import 失败 → 编译 → 重试 import"模式(详见 loadRouteModule 的同名章节)
  if (isDevOnDemandEnabled() && rootDir) {
    const dist = getDevDist();
    if (dist) {
      const sourcePath = prodPathToSourcePath(filePath, rootDir, dist);
      if (sourcePath && fs.existsSync(sourcePath)) {
        try {
          await ensureCompiled(sourcePath, rootDir, dist);
        } catch (compileErr) {
          const reason = compileErr instanceof Error ? compileErr.message : String(compileErr);
          throw new Error(`Failed to compile tool module "${sourcePath}": ${reason}`, {
            cause: compileErr,
          });
        }
      }
    }
  }

  // import 模块(dev 按需模式下走 Node 原生 import 绕过 Vite SSR 缓存)
  let module: Record<string, unknown>;
  try {
    module = await importWithCacheBust(filePath, isDevOnDemandEnabled());
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load tool module "${filePath}": ${reason}`, { cause: err });
  }

  const handler = resolveExport(module, functionName);

  // 内联校验(与 validateRouteModule 同构,但错误消息提到 tool 而非 method)
  if (typeof handler !== 'function') {
    throw new Error(
      `Tool module "${filePath}" does not export a valid function for "${functionName}". ` +
        `Expected a function, got ${handler === undefined ? 'undefined' : typeof handler}.`,
    );
  }

  // typeof 缩窄后为 Function 广义类型,断言为具体的函数签名
  return { handler: handler as (...args: unknown[]) => unknown, functionName };
}
