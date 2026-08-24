/**
 * agent 清单记录
 *
 * 由 [scanAgents](./scanAgents.md) 扫描文件系统生成，描述一个 agent 的元信息。
 * 与 [ToolManifest](../tools/toolTypes.md) 对称——一个目录一个 agent，handler.ts
 * 导出 `config` 块和可选的 `run` 函数。
 *
 * agent 名来自目录名（如 `src/agents/researcher/handler.ts` → `researcher`），
 * 可被 JSDoc `@agent` 覆盖（见 [extractAgentMetadata](../ast/extractAgentMetadata.md)，
 * Phase 1.8）。
 *
 * `hasRun` 在扫描阶段通过正则检测 `run` 导出是否存在（不 import 模块），
 * 实际 config 块字段提取（systemPrompt / tools / agents / model / maxTurns）
 * 由 [extractAgentMetadata](../ast/extractAgentMetadata.md) 在 AST 阶段完成。
 *
 * > `hasConfig` 字段已移除——它原本用于控制 `loadAgentModule` 是否提取 `config` 对象,
 * 但审计发现 `executeSubAgent` 拿到 `mod.config` 后从未读取(run 函数在自己模块内
 * 直接引用 config 变量),属于死链路。
 */
export interface AgentManifest {
  /** agent 名（目录名，如 `researcher`），可被 `@agent` JSDoc 覆盖 */
  name: string;
  /** 源码相对路径，如 `src/agents/researcher/handler.ts` */
  filePath: string;
  /** 是否导出 `run` 函数（自定义 agent 运行逻辑，替代默认 reactLoop） */
  hasRun: boolean;
}

export type AgentManifestList = AgentManifest[];
