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
 * 加载后的 agent 模块
 *
 * 与 [ToolModule](./loadToolModule.md) 对称——agent 不像 tool 只有一个 handler 函数,
 * 它导出 `config` 块（对象，含运行时可能动态求值的字段）和可选的 `run` 函数。
 *
 * - `config`：agent 配置对象（含 systemPrompt / tools / agents / model / maxTurns 等，
 *   以及任何非字面量字段——AST 阶段仅提取字面量，动态值需运行时加载）
 * - `run`：自定义 agent 运行逻辑（可选，替代默认 reactLoop）
 *
 * `AgentMetadata`（从 `faapi-agents.js` 水合）已含字面量字段，`loadAgentModule`
 * 用于在运行时拿到完整 config 对象（含动态字段）和 run 函数引用。
 */
export interface AgentModule {
  /**
   * agent 配置对象（含运行时字段）
   *
   * `hasConfig` 为 true 时一定存在；为 false 时为 `undefined`。
   * 可能是对象字面量（`export const config = {...}`）或函数返回值（`export function config() { return {...} }`）。
   *
   * 函数形式：本模块调用 `config()` 拿到返回值（无参调用，与 AST 阶段的字面量提取不同——
   * 运行时可拿到动态求值结果）。
   */
  config: Record<string, unknown> | undefined;
  /**
   * 自定义 agent 运行函数（可选）
   *
   * `hasRun` 为 true 时一定为 function；为 false 时为 `undefined`。
   * 调用方式由 `@faapi/agent` 子包的 Agent 类定义（Phase 3.x）。
   */
  run: ((...args: unknown[]) => unknown) | undefined;
}

/**
 * 动态 import agent handler 文件并提取 `config` 和 `run` 导出
 *
 * Dev 按需编译模式（Vite 风格）：先 `ensureCompiled` 确保产物存在再 import,
 * 避免 import 不存在的文件污染 Vite SSR 内部状态（详见 [loadRouteModule](./loadRouteModule.md)）。
 * Prod 模式：产物在 build 阶段已固化，直接 import，失败即报错。
 *
 * 与 [loadToolModule](./loadToolModule.md) 的差异：
 * - tool 按 `functionName` 提取单个函数（校验为 function）
 * - agent 提取 `config`（对象或函数返回对象）和 `run`（函数，可选）
 * - agent 的 config 可能为函数形式（`export function config() { return {...} }`），
 *   本模块自动调用拿到返回值（与 AST 阶段仅提字面量不同——运行时拿动态值）
 *
 * 错误传递：
 * - 编译失败 → 抛 "Failed to compile agent module"
 * - import 失败 → 抛 "Failed to load agent module"
 *
 * @param filePath agent handler 文件的绝对路径（产物形式，如 `dist/agents/researcher/handler.js`）
 * @param hasConfig 是否应提取 config 导出（来自 `AgentMetadata.hasConfig`）
 * @param hasRun 是否应提取 run 导出（来自 `AgentMetadata.hasRun`）
 * @param rootDir 项目根目录（按需编译模式用，可选）
 */
export async function loadAgentModule(
  filePath: string,
  hasConfig: boolean,
  hasRun: boolean,
  rootDir?: string,
): Promise<AgentModule> {
  // Dev 按需模式：先确保编译再 import
  if (isDevOnDemandEnabled() && rootDir) {
    const dist = getDevDist();
    if (dist) {
      const sourcePath = prodPathToSourcePath(filePath, rootDir, dist);
      if (sourcePath && fs.existsSync(sourcePath)) {
        try {
          await ensureCompiled(sourcePath, rootDir, dist);
        } catch (compileErr) {
          const reason = compileErr instanceof Error ? compileErr.message : String(compileErr);
          throw new Error(`Failed to compile agent module "${sourcePath}": ${reason}`, {
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
    throw new Error(`Failed to load agent module "${filePath}": ${reason}`, { cause: err });
  }

  // 提取 config：hasConfig 为 true 时解析,失败抛错
  let config: Record<string, unknown> | undefined;
  if (hasConfig) {
    const configExport = resolveExport(module, 'config');
    if (configExport === undefined) {
      throw new Error(
        `Agent module "${filePath}" does not export "config" (hasConfig=true but export missing).`,
      );
    }
    if (typeof configExport === 'function') {
      // 函数形式：export function config() { return {...} } / export const config = () => ({...})
      const returned = (configExport as (...args: unknown[]) => unknown)();
      if (returned === null || typeof returned !== 'object') {
        throw new Error(
          `Agent module "${filePath}" config() did not return an object (got ${returned === null ? 'null' : typeof returned}).`,
        );
      }
      config = returned as Record<string, unknown>;
    } else if (typeof configExport === 'object' && configExport !== null) {
      // 对象字面量：export const config = {...}
      config = configExport as Record<string, unknown>;
    } else {
      throw new Error(
        `Agent module "${filePath}" config export must be an object or function, got ${typeof configExport}.`,
      );
    }
  }

  // 提取 run：hasRun 为 true 时解析并校验为 function,失败抛错
  let run: ((...args: unknown[]) => unknown) | undefined;
  if (hasRun) {
    const runExport = resolveExport(module, 'run');
    if (typeof runExport !== 'function') {
      throw new Error(
        `Agent module "${filePath}" does not export a valid "run" function (hasRun=true). ` +
          `Expected a function, got ${runExport === undefined ? 'undefined' : typeof runExport}.`,
      );
    }
    run = runExport as (...args: unknown[]) => unknown;
  }

  return { config, run };
}
