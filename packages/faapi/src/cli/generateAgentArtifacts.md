# generateAgentArtifacts

一句话概括：从 `AgentManifest[]`（路径推导）经 AST 增强生成 `faapi-agents.js` 清单产物，供运行时水合到 `agentRegistry`。

## 为什么需要

agent 与 tool 一样采用扫描式发现，`scanAgents` 启动时只读源码 + 正则检测 config/run 导出（零 import），产出 `AgentManifest[]`。但 manifest 仅含路径推导字段（`name` / `filePath` / `hasConfig` / `hasRun`），不含 JSDoc 描述、`@agent` 覆盖名、config 块字段（systemPrompt / tools / agents / model / maxTurns）。

这些字段需要 TypeScript AST 提取（由 [extractAgentMetadata](../ast/extractAgentMetadata.md) 完成），提取结果序列化为 `faapi-agents.js`（ESM 模块导出 `agents` 数组），运行时由 [createAppCore](./createAppCore.md) 水合到 [agentRegistry](../injection/agentRegistry.md)。

## 使用场景

- `devCommand` 启动时调 `generateAgentArtifactsForDev`（仅生成清单，无 zod.js）→ `.faapi/faapi-agents.js`
- `buildCommand` 构建时调 `generateAgentArtifacts` → `dist/faapi-agents.js`
- `createDevApp.reloadAgents` 热替换时重新生成 + 重新水合（watcher 触发）
- `createAppBase` 启动时 `loadAndHydrateAgents` 读 `faapi-agents.js` → `hydrateAgents` → `hydrateAgentRegistry`

## 设计

### 不生成 zod.js（与 tool 的关键差异）

agent **没有用户输入参数**——`config` 块字段已在 [extractAgentMetadata](../ast/extractAgentMetadata.md) AST 阶段提取为字面量值（字符串/字符串数组/数字），运行时无需 schema 校验。

`run` 函数（自定义 agent 运行逻辑）的参数是 `AgentContext` 等框架内部类型，不接收 LLM JSON 调用输入。若 agent 需要作为 tool 暴露给 LLM 调用，其输入校验由 [agentRegistry.asTool()](../injection/agentRegistry.md)（Phase 2.2）或 `@faapi/agent` 子包（Phase 3.x）处理，不在本模块。

### 序列化 + 水合往返

```
AgentManifest[] (scanAgents, 路径推导)
    ↓ extractAgentMetadata (AST 增强)
AgentMetadata[] (含 description / @agent 覆盖 / config 块字段)
    ↓ serializeAgents (filePath: src/... → <dist>/...)
SerializedAgentRecord[] (可写入 JS)
    ↓ writeAgentsModule (JSON.stringify 嵌入 ESM)
faapi-agents.js
    ↓ importWithCacheBust + hydrateAgents
AgentMetadata[] (水合还原, filePath 为产物形式)
    ↓ hydrateAgentRegistry
agentRegistry 单例
```

### filePath 产物化

源码 `src/agents/researcher/handler.ts` → 产物 `dist/agents/researcher/handler.js`（dev 为 `.faapi/agents/researcher/handler.js`）。

打平 `src/` 前缀 + dist 前缀 + `.ts` → `.js`，与 [generateToolArtifacts.toProdFilePath](./generateToolArtifacts.md) / [generateRoutes.toProdFilePath](./generateRoutes.md) 同构。

### undefined 字段处理

`description` / `systemPrompt` / `tools` / `agents` / `model` / `maxTurns` 在 JSON.stringify 时自动省略，水合时通过 `?? undefined` 兜底，保证 `AgentMetadata` 类型完整。

## API

| 导出 | 说明 |
| --- | --- |
| `generateAgentArtifacts(agents, rootDir, dist)` | 主入口：AST 增强 + 序列化 + 写入 `faapi-agents.js`，返回 `AgentMetadata[]` |
| `serializeAgents(agents, dist?)` | 序列化 `AgentMetadata[]` → `SerializedAgentRecord[]`（filePath 转产物形式） |
| `hydrateAgents(manifest)` | 水合 `SerializedAgentRecord[]` → `AgentMetadata[]`（undefined 字段兜底） |
| `writeAgentsModule(manifest, outputPath)` | 写入 `faapi-agents.js` ESM 模块 |
| `SerializedAgentRecord` | 序列化记录类型（filePath 为产物形式） |

## 与 generateToolArtifacts 的对比

| 维度 | generateToolArtifacts | generateAgentArtifacts |
| --- | --- | --- |
| 输入 | `ToolManifest[]` | `AgentManifest[]` |
| AST 增强器 | `extractToolMetadata` | `extractAgentMetadata` |
| 元数据字段 | name/functionName/description/inputTypeName | name/description/hasConfig/hasRun/systemPrompt/tools/agents/model/maxTurns |
| 清单产物 | `faapi-tools.js`（导出 `tools`） | `faapi-agents.js`（导出 `agents`） |
| zod.js 生成 | 每个 handler.ts 一个 `zod.js`（coerce=false） | **不生成**（agent 无输入参数） |
| skipSchema 选项 | 有（dev 按需模式跳过 zod.js） | 无（没有 schema 可跳过） |
| 运行时加载 | `loadToolModule`（按 functionName 提取函数） | `loadAgentModule`（提取 config 块 + run 函数） |

## 相关模块

- [scanAgents](../agents/scanAgents.md) - 扫描 `src/agents/*/handler.ts` 产出 `AgentManifest[]`
- [extractAgentMetadata](../ast/extractAgentMetadata.md) - `AgentMetadata` 类型定义 + AST 提取
- [loadAgentModule](../loader/loadAgentModule.md) - 运行时按需 import `agent.js` 提取 config/run
- [agentRegistry](../injection/agentRegistry.md) - agent 注册表单例（水合 + 查询）
- [createAppCore](./createAppCore.md) - 启动时 `loadAndHydrateAgents` 入口
- [generateToolArtifacts](./generateToolArtifacts.md) - tool 产物生成（对称模块）
