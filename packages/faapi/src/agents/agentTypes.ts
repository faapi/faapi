/**
 * agent 清单记录
 *
 * 由 [scanAgents](./scanAgents.md) 扫描文件系统生成，描述一个 agent 的元信息。
 * 与 [ToolManifest](../tools/toolTypes.md) 对称——一个目录一个 agent，handler.ts
 * 导出 `config` 块（systemPrompt / tools / agents / model / maxTurns /
 * inputDescription / systemPromptFile）。
 *
 * agent 名来自目录名（如 `src/agents/researcher/handler.ts` → `researcher`），
 * 可被 JSDoc `@agent` 覆盖（见 [extractAgentMetadata](../ast/extractAgentMetadata.md)，
 * Phase 1.8）。
 *
 * agent 统一为声明式执行（config + 默认 reactLoop）——自定义 `run` 导出已移除，
 * 检测到 `run` 导出在 AST 阶段抛迁移错误（编排场景注册 tool）。
 *
 * > `hasConfig` 字段已移除——它原本用于控制 `loadAgentModule` 是否提取 `config` 对象,
 * 但审计发现 `executeSubAgent` 拿到 `mod.config` 后从未读取,属于死链路。
 * > `hasRun` 字段已随自定义 run 机制一并移除（同上,自定义执行路径不再存在）。
 */
export interface AgentManifest {
  /** agent 名（目录名，如 `researcher`），可被 `@agent` JSDoc 覆盖 */
  name: string;
  /** 源码相对路径，如 `src/agents/researcher/handler.ts` */
  filePath: string;
}

export type AgentManifestList = AgentManifest[];
