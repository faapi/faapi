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
 * 与 [ToolModule](./loadToolModule.md) 对称——agent 的代码本体只有可选的 `run` 函数
 * (自定义 agent 运行逻辑,替代默认 reactLoop)。
 *
 * > `config` 字段已移除——`AgentMetadata` 已含 AST 提取的字面量字段
 * > (systemPrompt / tools / agents / model / maxTurns),`AgentModule.config`
 * > 原本用于运行时拿到完整 config 对象(含动态字段),但 `executeSubAgent`
 * > 拿到 `mod.config` 后从不读取(run 函数在自己模块内直接引用 config 变量),
 * > 属于死链路,故移除。
 *
 * `AgentMetadata`（从 `faapi-agents.js` 水合）已含字面量字段,本模块仅用于
 * 在运行时拿到 `run` 函数引用。
 */
export interface AgentModule {
  /**
   * 自定义 agent 运行函数（可选）
   *
   * `hasRun` 为 true 时一定为 function；为 false 时为 `undefined`。
   * 调用方式由 `@faapi/agent` 子包的 Agent 类定义（Phase 3.x）。
   */
  run: ((...args: unknown[]) => unknown) | undefined;
}

/**
 * 动态 import agent handler 文件并提取 `run` 导出
 *
 * Dev 按需编译模式（Vite 风格）：先 `ensureCompiled` 确保产物存在再 import,
 * 避免 import 不存在的文件污染 Vite SSR 内部状态（详见 [loadRouteModule](./loadRouteModule.md)）。
 * Prod 模式：产物在 build 阶段已固化，直接 import，失败即报错。
 *
 * 与 [loadToolModule](./loadToolModule.md) 的差异：
 * - tool 按 `functionName` 提取单个函数（校验为 function）
 * - agent 只提取 `run`（函数，可选）——config 块字段已在 AST 阶段提取为字面量,
 *   运行时无需再加载 config 对象
 *
 * 错误传递：
 * - 编译失败 → 抛 "Failed to compile agent module"
 * - import 失败 → 抛 "Failed to load agent module"
 *
 * @param filePath agent handler 文件的绝对路径（产物形式，如 `dist/agents/researcher/handler.js`）
 * @param hasRun 是否应提取 run 导出（来自 `AgentMetadata.hasRun`）
 * @param rootDir 项目根目录（按需编译模式用，可选）
 */
export async function loadAgentModule(
  filePath: string,
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

  return { run };
}
