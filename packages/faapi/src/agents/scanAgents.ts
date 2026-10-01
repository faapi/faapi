import fg from 'fast-glob';
import type { AgentManifestList } from './agentTypes';

/**
 * 默认 agent 扫描 patterns
 *
 * 与 tool 扫描（[TOOL_PATTERNS](../tools/scanTools.md)）对称——
 * agent 定义文件约定放在 `src/agents` 下的任意层级 `handler.ts`，支持多级嵌套目录
 * （`src/agents/` + `<name>/handler.ts` 平铺与 `<group>/<name>/handler.ts` 分组嵌套）。
 * `**` 匹配零级或多级目录，平铺场景行为与旧版单段通配 pattern 完全一致。
 *
 * 由 devCommand / buildCommand / createDevApp.reloadAgents（Phase 1.9）共享，
 * 避免多处重复定义。
 */
export const DEFAULT_AGENT_PATTERNS = ['src/agents/**/handler.ts'];

/**
 * 从文件路径提取 agent 名
 *
 * 匹配 `agents/<subpath>/handler.ts` 模式（任意前缀），取 `agents/` 之后、`handler.ts`
 * 之前的完整子路径，`/` 规范化为 `.`（与 asTool 的 `agent.<name>` 工具命名、
 * 既有平铺点号目录的调用名一致）。
 *
 * - `src/agents/researcher/handler.ts` → `researcher`
 * - `src/agents/easy-writing/wizard/handler.ts` → `easy-writing.wizard`
 * - `backup/agents/researcher/handler.ts` → `researcher`（任意前缀，只要匹配 agents/.../handler.ts）
 *
 * @throws 路径不匹配 agent 模式时抛错（不应发生——glob pattern 已限制）
 */
function extractAgentNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)agents\/(.+)\/handler\.ts$/);
  if (!match) {
    throw new Error(
      `Not an agent path: "${filePath}". Expected pattern: src/agents/<name>/handler.ts`,
    );
  }
  return match[1]!.replace(/\//g, '.');
}

/**
 * 扫描 agents 目录，生成 agent 清单
 *
 * Vite 风格：启动时只读源码文件列表，不 import agent.js。config 块字段的精确提取
 * （含 JSDoc description）由 [extractAgentMetadata](../ast/extractAgentMetadata.md)
 * 在 AST 阶段完成——检测到 `run` 导出（自定义执行已移除）也在该阶段抛迁移错误。
 *
 * agent 文件格式：`src/agents/<agentName>/handler.ts`，导出 `config` 块。一个目录
 * 一份 handler.ts = 一个 agent。
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
    });
  }

  return agents;
}
