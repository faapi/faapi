# agentTypes

一句话概括：定义 agent 相关的核心类型，包括 agent 清单记录。

## 为什么需要

agent 层多个模块（扫描、生成产物、加载、注册表）共享同一套类型定义。集中定义避免循环依赖和类型不一致。与 [toolTypes](../tools/toolTypes.md) 对称。

## 使用场景

- `scanAgents` 返回 `AgentManifest[]`
- `generateAgentArtifacts` 序列化 / `hydrateAgents` 水合 `AgentManifest`
- `agentRegistry` 持有 `AgentManifest[]` 提供 `getAgent` / `listAgents`
- `extractAgentMetadata` 从 `AgentManifest` 入参做 AST 增强（JSDoc / config 块字段）

## AgentManifest 字段说明

| 字段 | 类型 | 用途 |
|------|------|------|
| `name` | `string` | agent 名（目录名，如 `researcher`）。对 LLM 可见。可被 `@agent` JSDoc 覆盖（见 [extractAgentMetadata](../ast/extractAgentMetadata.md)） |
| `filePath` | `string` | 源码相对路径（如 `src/agents/researcher/handler.ts`），AST 提取需要 `.ts` |
| `hasConfig` | `boolean` | 是否导出 `config` 块。`true` 时 AST 阶段提取 config 字段（systemPrompt / tools / agents / model / maxTurns） |

### 字段说明

| `false` | `true` | 纯自定义 agent（无配置块，`run` 全权控制） |
| `false` | `false` | 空 agent（仅目录占位，无实际作用） |

## 相关模块

- [scanAgents](./scanAgents.md) - 生成 `AgentManifest[]`
- [extractAgentMetadata](../ast/extractAgentMetadata.md) - AST 增强 `AgentManifest`（Phase 1.8）
- [generateAgentArtifacts](../cli/generateAgentArtifacts.md) - 序列化/水合 `AgentManifest`（Phase 1.9）
- [agentRegistry](../injection/agentRegistry.md) - 运行时 agent 注册表（Phase 2.2）
