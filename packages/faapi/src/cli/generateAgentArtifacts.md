# generateAgentArtifacts

一句话概括：从 `AgentManifest[]`（路径推导）经 AST 增强生成 `faapi-agents.js` 清单产物 + 声明 `Input` 的 agent zod.js，供运行时水合到 `agentRegistry` 与派发入参校验。

## 为什么需要

agent 与 tool 一样采用扫描式发现，`scanAgents` 启动时只读文件列表（零 import），产出 `AgentManifest[]`。manifest 仅含路径推导字段（`name` / `filePath`），不含 JSDoc 描述、`@agent` 覆盖名、config 块字段（systemPrompt / tools / agents / model / maxTurns / inputDescription）与派发入参 schema 声明（`inputTypeName`）。

这些字段需要 TypeScript AST 提取（由 [extractAgentMetadata](../ast/extractAgentMetadata.md) 完成），提取结果序列化为 `faapi-agents.js`（ESM 模块导出 `agents` 数组），运行时由 [createAppCore](./createAppCore.md) 水合到 [agentRegistry](../injection/agentRegistry.md)。

## 使用场景

- `devCommand` 启动时调 `generateAgentArtifactsForDev`（清单 + 声明 `Input` 的 agent zod.js 全量生成）→ `.faapi/faapi-agents.js`
- `buildCommand` 构建时调 `generateAgentArtifacts` → `dist/faapi-agents.js` + zod.js
- `createDevApp.reloadAgents` 热替换时重新生成 + 重新水合（watcher 触发）
- `createAppBase` 启动时 `loadAndHydrateAgents` 读 `faapi-agents.js` → `hydrateAgents` → `hydrateAgentRegistry`

## 设计

### agent zod.js（声明 `Input` 时生成，与 tool 复用同一管线）

`AgentMetadata.inputTypeName` 非 `undefined`（handler.ts 顶层声明 `interface Input` / `type Input`，见 [extractAgentMetadata](../ast/extractAgentMetadata.md)「派发入参 schema 声明」）的 agent，本模块额外生成 `<dist>/agents/<name>/zod.js`（与 handler.js 同级），导出 `InputSchema`——`@faapi/agent` 派发该 agent 时经 [loadToolSchema](../loader/loadToolSchema.md) 加载、`z.toJSONSchema` 组装 LLM 可见 parameters 并做 runtime 校验。

生成管线与 tool 完全复用：`extractTypeInfo(program, filePath, 'Input')` 提取类型（**复用元数据提取阶段已创建的 Program**，零额外解析成本）→ `generateToolSchemaFileSource`（coerce=false——入参来自 LLM JSON 调用，与 tool 一致；task 管线已先有复用先例）→ [generateZodArtifacts](./generateZodArtifacts.md) 共享管线写文件。

**dev/prod 同路径全量生成**，不引入 tool 式 `skipSchema` 按需模式。理由：agent 数量级小（十位数）且 Program 已复用，全量生成的边际成本可忽略；而「声明了 `Input` 但 zod.js 缺失」若走按需生成，运行时无法区分「尚未生成」与「产物损坏」，schema 会静默退回单字段模式——全量生成让该场景只剩产物异常一种可能，`@faapi/agent` 侧对它显式抛错（见 [agent](../../../agent/src/agent.md)「派发入参 schema 声明」）。

未声明 `Input` 的 agent 不生成 zod.js、清单无 `inputTypeName`——运行时保持单字段 `input` + `inputDescription` 行为，完全向后兼容。

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

打平 `src/` 前缀 + dist 前缀 + `.ts` → `.js`。实现为 [utils/prodPaths.toProdFilePath](../utils/prodPaths.md)（路由/tool/agent 清单生成的单一来源）。

### undefined 字段处理

`description` / `tools` / `agents` / `model` / `maxTurns` / `inputDescription` / `inputTypeName` 在 JSON.stringify 时自动省略，水合时通过 `?? undefined` 兜底，保证 `AgentMetadata` 类型完整。`systemPrompt` 经上游必填校验必有值。

### 清单级校验（不如预期即报错）

AST 提取层的单 agent 校验（systemPrompt 必填、字面量提取失败、未知字段等）之外，本模块在生成清单时做**跨 agent 的清单级校验**——这些问题只在多个 agent 组合时暴露，静默水合会让注册表处于与声明意图不符的状态：

| 场景 | 行为 |
|------|------|
| 某个 agent 源文件不在 Program 中(`extractAgentMetadata` 返回 null) | 抛错——正常构建链路不该发生，静默跳过会让 agent 从清单里无声消失 |
| agent 名重复(目录推导名或 `@agent` 覆盖名撞名) | 抛错——水合语义是后者覆盖前者，静默覆盖丢失 agent |
| `agents` 引用了清单中不存在的 agent 名 | 抛错——sub-agent 递归在运行时才失败会把错误推迟到首次调用，且错误信息不带构建上下文 |

`tools` 引用**不做**构建期校验——业务方 plugin 可在运行时注册额外 tool（`PluginContext.registries`），构建期校验会误报。

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
| 元数据字段 | name/functionName/description/inputTypeName | name/description/systemPrompt/tools/agents/model/maxTurns/inputDescription/inputTypeName |
| 清单产物 | `faapi-tools.js`（导出 `tools`） | `faapi-agents.js`（导出 `agents`） |
| zod.js 生成 | 每个 handler.ts 一个 `zod.js`（coerce=false） | 仅声明 `Input` 的 agent 生成（同管线复用，coerce=false） |
| zod.js 时机 | dev 按需（`skipSchema`）/ prod 全量 | dev/prod 一致全量（agent 数量小，声明了但缺失即产物异常） |
| 运行时加载 | `loadToolModule`（按 functionName 提取函数） | 无（声明式 agent，config 字段在清单中） |

## 相关模块

- [scanAgents](../agents/scanAgents.md) - 扫描 `src/agents/*/handler.ts` 产出 `AgentManifest[]`
- [extractAgentMetadata](../ast/extractAgentMetadata.md) - `AgentMetadata` 类型定义 + AST 提取
- [agentRegistry](../injection/agentRegistry.md) - agent 注册表单例（水合 + 查询）
- [createAppCore](./createAppCore.md) - 启动时 `loadAndHydrateAgents` 入口
- [generateToolArtifacts](./generateToolArtifacts.md) - tool 产物生成（对称模块）
