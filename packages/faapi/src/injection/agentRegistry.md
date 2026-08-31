# agentRegistry

一句话概括：agent 注册表单例，由 `createAppBase` 水合 `faapi-agents.js` 后填充，供 agent 注入器和 `@faapi/agent` 子包按名查找 agent 元数据、解析 agent 可用 tool 集合、把 agent 包装为 tool 供其他 agent 调用。

## 为什么需要

agent 调用 agent（sub-agent）、handler 注入 agent、reactLoop 加载 agent 时都需要按名查找 agent 元数据（`filePath` / `hasRun` / `systemPrompt` / `tools` / `agents` / `model` / `maxTurns` 等）。`faapi-agents.js` 是序列化产物（`SerializedAgentRecord[]`），启动时需还原为 `AgentMetadata[]` 并放入可查询的注册表。

与 [toolRegistry](./toolRegistry.md) 对称——单例 + 全量替换，避免传递引用。agent 运行时（`@faapi/agent` 子包）和 faapi 核心的 agent 注入器都能直接 import 此模块访问。

Phase 2.2 在基础查询 API 上扩展三个能力，对应 agent 三类用法：

| 能力 | 用法 | 对应 API |
| --- | --- | --- |
| agent 作为 tool 被 LLM 调用 | sub-agent 在父 agent 的 `agents` 列表中 | `asTool(name)` |
| 解析 agent 可用的 tool 集合 | reactLoop 给 LLM 发 tool 列表前 | `resolveAgentTools(name)` |
| 解析 agent 可调用的子 agent | reactLoop 把 sub-agent 包装为 tool 加入列表 | `resolveSubAgents(name)` |

## 使用场景

- `createAppBase` 启动时水合 `faapi-agents.js` → `hydrateAgentRegistry()`
- `createDevApp.reloadAgents` 热替换时重新水合（dev watcher 触发）
- agent 注入器（`injectParams`，Phase 2.3）按 `agent` / `agents` 参数名查找可用 agent 列表
- `@faapi/agent` 子包的 `Agent` 类（Phase 3.x）按 `agent.name` 查找元数据，再调 `loadAgentModule` 加载 handler 执行
- `@faapi/agent` 子包的 `reactLoop`（Phase 3.3）调 `resolveAgentTools(name)` + `resolveSubAgents(name)` + `asTool()` 组装 LLM 可见 tool 列表

## 设计

### 单例 + 全量替换

- `hydrateAgentRegistry(agents)` —— 全量替换注册表内容（启动 + reload 调用）
- `clearAgentRegistry()` —— 清空（app close 时调用，与 `clearToolRegistry` / `clearSkillRegistry` / `setCurrentApp(null)` 对称）

全量替换而非增量注册：agent 清单来自编译期产物，reload 时整体重新生成，增量追踪反而复杂（与 `hydrateToolRegistry` 同构）。

### 与 skillRegistry 的关系 — 物理隔离

本注册表只承载文件型 agent（编译期 `faapi-agents.js` 产物来源）。[skillRegistry](./skillRegistry.md) 是独立的运行时动态 skill 注册表，供业务方 plugin 内部使用（DB-driven skill 的 hydrate / upsert / remove）。

**职责正交不耦合**：

- **agent 负责核心流程**：含 `run` 函数的多步 prompt 串联、文件型入口、sub-agent 递归
- **skill 用于拓展**：运行时动态补充的 LLM 可见元数据，业务方 plugin 自行编排使用

本模块的查询函数（`getAgent` / `listAgents` / `asTool` / `resolveAgentTools` / `resolveSubAgents`）**不 fallback 到 skillRegistry**——skill 不参与 agent 查询链路、不覆盖文件型 agent、不参与 sub-agent 递归。skill 不再被 agent 的 `agents` 列表自动引用。

`reloadAgents`（dev watcher 触发）只重新 hydrate 文件 registry；skillRegistry 由业务方 plugin 自行管理生命周期（`hydrateSkillRegistry` / `upsertSkill` / `removeSkill`），dev 改文件不会清空 skillRegistry，业务方需自行在 `onReady` 或监听 DB change stream 时维护。

### 基础查询 API — Core/Entry 双查询模式

agent 元数据分两层接口，对应两类使用方（详见 [extractAgentMetadata](../ast/extractAgentMetadata.md)）：

- **`AgentCore`** —— `name` / `description?` / `systemPrompt?` / `tools?` / `agents?` / `model?` / `maxTurns?`（LLM 可见字段，不含代码加载细节）。文件型 agent 实现此接口。
- **`AgentMetadata extends AgentCore`** —— 额外含 `filePath`（加载 `handler.js` 用）/ `hasRun`（是否导出 `run` 函数）。仅文件型 agent 实现。

| 方法 | 返回类型 | 用途 |
| --- | --- | --- |
| `getAgent(name)` | `AgentCore \| undefined` | LLM-facing 场景：`agents` 注入器、`asTool` 描述、`resolveAgentTools` / `resolveSubAgents` 解析。仅查文件 registry |
| `getAgentEntry(name)` | `AgentMetadata \| undefined` | 框架内部：`@faapi/agent` 子包加载 `handler.js`、检查 `hasRun` 决定走 `run` 函数还是单轮 prompt |
| `listAgents()` | `AgentCore[]` | 返回所有已注册文件型 agent（不合并 skillRegistry；副本，修改不影响内部状态） |

**调用方选择**：消费 LLM 可见字段（`systemPrompt` / `tools` / `agents` / `model` / `maxTurns`）的代码用 `getAgent`；需要 `filePath` / `hasRun` 加载源码的代码用 `getAgentEntry`。

### Phase 2.2 扩展能力

#### `asTool(name)` — agent 包装为 tool

把 agent 包装为 `AgentToolDescriptor`（与 `ToolMetadata` 平行结构），供 LLM 当作 tool 调用。

- `name` 默认 `agent.<agentName>`（前缀避免与常规 tool 冲突，reactLoop 据此识别 sub-agent 递归）
- `description` 透传 `agent.description`
- `metadata` 持有 `AgentCore` 引用（reactLoop 取 `systemPrompt` / `model` / `maxTurns`）；`filePath` / `hasRun` 由 `@faapi/agent` 子包通过 `getAgentEntry` 单独获取
- 不含 input schema——agent `run` 函数参数为开放式（任意 JSON），无类型约束；Phase 3.x 可扩展
- 未注册返回 `undefined`

reactLoop 把 `AgentToolDescriptor` 与 `ToolMetadata` 合并为统一 tool 列表发往 LLM，按 `kind` 字段路由执行（`tool` → `loadToolModule`；`agent` → `loadAgentModule` + 递归）。

#### `resolveAgentTools(name)` — 解析可用 tool 集合

返回 `ToolMetadata[]`，**只包含 agent 显式声明的 tool**：

- **agent 显式声明的 `tools`**：`agent.tools` 列表中的 tool 名，按名从 `toolRegistry.getTool()` 查找

不再合并全局共享 tool（已移除 `defaultTools`）——sub-agent 的合并由 `@faapi/agent` 的 `Agent.buildToolDefinitions` 在更上层完成（按 `name` 去重）。`resolveAgentTools` 只关心 agent 自身显式声明的部分，职责单一。

`tools` 中未在 toolRegistry 找到的 tool 名静默跳过（tool 可选可用，不强制存在）。

agent 未注册返回空数组。

#### `resolveSubAgents(name)` — 解析子 agent 集合

读 `agent.agents` 字段（[extractAgentMetadata](../ast/extractAgentMetadata.md) 提取的字面量列表），按名查找已注册 agent，返回 `AgentCore[]`（LLM-facing 字段，供 `@faapi/agent` 子包包装为 `AgentToolDescriptor`；`filePath` / `hasRun` 由子包通过 `getAgentEntry` 单独获取）。

- `agents` 字段未设置 / 含未注册的 agent 名 → 跳过
- agent 未注册返回空数组
- 返回副本，修改不影响内部状态

reactLoop 组装 LLM tool 列表：`resolveAgentTools(name)` 的 `ToolMetadata[]` + `resolveSubAgents(name).map(a => asTool(a.name))` 的 `AgentToolDescriptor[]`。

### faapi-agents.js 缺失处理

项目可能没有任何 agent（纯 API 项目）。`faapi-agents.js` 不存在时，`createAppBase` 跳过水合，注册表保持空——与 `faapi-tools.js`（可选产物）对称，与 `faapi-routes.js`（必需产物）不同，agent 是可选能力。

## 跨注册表依赖

`resolveAgentTools` 依赖 [toolRegistry](./toolRegistry.md) 的 `getTool`——两个注册表协同工作，由 `createAppBase` 在同一启动阶段水合。reload 时 `reloadTools` + `reloadAgents` 都触发，保证两个注册表一致。

## 相关模块

- [generateAgentArtifacts](../cli/generateAgentArtifacts.md) - 生成 `faapi-agents.js`
- [extractAgentMetadata](../ast/extractAgentMetadata.md) - `AgentMetadata` 类型定义
- [loadAgentModule](../loader/loadAgentModule.md) - 按 `filePath` + `hasRun` 按需加载 agent handler
- [createAppCore](../cli/createAppCore.md) - 启动时水合入口（`loadAndHydrateAgents`）
- [toolRegistry](./toolRegistry.md) - tool 注册表（对称模块，`resolveAgentTools` 在此按 agent.tools 解析可用 tool）
