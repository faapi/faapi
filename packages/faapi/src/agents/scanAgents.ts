import fg from 'fast-glob';
import path from 'node:path';
import fs from 'node:fs';
import type { AgentManifestList } from './agentTypes';

/**
 * 默认 agent 扫描 patterns
 *
 * 与 tool 扫描（[TOOL_PATTERNS](../tools/scanTools.md)）对称——
 * agent 定义文件约定放在 `src/agents/<agentName>/handler.ts`（一级目录）。
 *
 * 由 devCommand / buildCommand / createDevApp.reloadAgents（Phase 1.9）共享，
 * 避免多处重复定义。
 */
export const DEFAULT_AGENT_PATTERNS = ['src/agents/*/handler.ts'];

/**
 * 检测 `config` 块导出
 *
 * 匹配：
 * - `export const config = { ... }` — 对象字面量（最常见）
 * - `export const config = () => ({ ... })` — 函数返回配置
 * - `export function config() { ... }` — 函数声明
 *
 * 不匹配（`\b` 词边界保证精确匹配 `config`）：
 * - `export const configuration = ...`（config 后跟 `uration`）
 * - `export const config2 = ...`（config 后跟 `2`）
 *
 * 正则检测仅用于扫描阶段快速判断导出是否存在，实际 config 块字段提取
 * 由 [extractAgentMetadata](../ast/extractAgentMetadata.md) 在 AST 阶段完成。
 */
const CONFIG_EXPORT_RE = /export\s+(?:const|function)\s+config\b/;

/**
 * 检测 `run` 函数导出
 *
 * 匹配：
 * - `export function run() { ... }`
 * - `export async function run() { ... }`
 * - `export const run = () => { ... }`
 * - `export const run = async () => { ... }`
 *
 * 不匹配（`\b` 词边界保证精确匹配 `run`）：
 * - `export const runtime = ...`（run 后跟 `time`）
 */
const RUN_EXPORT_RE = /export\s+(?:async\s+)?(?:function\s+|const\s+)run\b/;

/**
 * 从文件路径提取 agent 名
 *
 * 匹配 `src/agents/<agentName>/handler.ts` 模式，提取 `<agentName>`。
 *
 * - `src/agents/researcher/handler.ts` → `researcher`
 * - `backup/agents/researcher/handler.ts` → `researcher`（任意前缀，只要匹配 agents/<name>/handler.ts）
 *
 * @throws 路径不匹配 agent 模式时抛错（不应发生——glob pattern 已限制）
 */
function extractAgentNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)agents\/([^/]+)\/handler\.ts$/);
  if (!match) {
    throw new Error(
      `Not an agent path: "${filePath}". Expected pattern: src/agents/<name>/handler.ts`,
    );
  }
  return match[1]!;
}

/**
 * 从源码检测 config / run 导出是否存在
 *
 * 返回 `{ hasConfig, hasRun }`，两个布尔值独立检测。
 * 不 import 模块——正则匹配源码文本（Vite 风格，与 [scanTools](../tools/scanTools.md) 的
 * `extractToolExportsFromSource` 同构）。
 */
function detectAgentExports(source: string): { hasConfig: boolean; hasRun: boolean } {
  return {
    hasConfig: CONFIG_EXPORT_RE.test(source),
    hasRun: RUN_EXPORT_RE.test(source),
  };
}

/**
 * 扫描 agents 目录，生成 agent 清单
 *
 * Vite 风格：启动时只读源码 + 正则检测 config/run 导出，不 import agent.js。
 * agent.js 加载延后到 [loadAgentModule](../loader/loadAgentModule.md) 请求阶段（Phase 1.9）。
 *
 * agent 文件格式：`src/agents/<agentName>/handler.ts`，导出 `config` 块（可选）和
 * `run` 函数（可选）。一个目录一份 handler.ts = 一个 agent。
 *
 * 重名检测：同 agent 名出现在多个文件 → 抛错（agent 名全局唯一，无作用域维度）。
 *
 * @param rootDir 项目根目录
 * @param patterns glob patterns（源码 .ts 路径，匹配 agent handler 文件）
 * @returns `AgentManifestList`
 */
export async function scanAgents(rootDir: string, patterns: string[]): Promise<AgentManifestList> {
  const files = await fg(patterns, {
    cwd: rootDir,
    onlyFiles: true,
    absolute: false,
  });

  const agents: AgentManifestList = [];
  // 重名检测：agentName → filePath
  const seen = new Map<string, string>();

  for (const file of files) {
    const normalizedFile = file.replace(/\\/g, '/');
    const fileName = normalizedFile.split('/').pop()!;

    // 只处理 handler.ts（与路由/tool handler.ts 对称），其他 .ts 文件跳过
    if (fileName !== 'handler.ts' && fileName !== 'handler.js') {
      continue;
    }

    const absPath = path.resolve(rootDir, normalizedFile);
    const source = await fs.promises.readFile(absPath, 'utf8').catch(() => '');
    const { hasConfig, hasRun } = detectAgentExports(source);
    const name = extractAgentNameFromPath(normalizedFile);

    // 重名检测：同 agent 名报错
    const prevFile = seen.get(name);
    if (prevFile) {
      throw new Error(
        `Agent conflict: "${name}" declared in both ${prevFile} and ${normalizedFile}`,
      );
    }
    seen.set(name, normalizedFile);

    agents.push({
      name,
      filePath: normalizedFile,
      hasConfig,
      hasRun,
    });
  }

  return agents;
}
