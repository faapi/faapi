# agentRegistry

一句话概括：agent 注册表——app 实例级实现见 [registries.md](./registries.md)；本模块保留全局函数作为默认实例的便捷访问器（框架链路已改走 app 实例）。水合数据由 [loadAgents](../agents/loadAgents.md) 启动期求值产出（`AgentMetadata[]`），供 agent 注入器和 `@faapi/agent` 子包按名查找 agent 元数据、解析 agent 可用 tool 集合、把 agent 包装为 tool 供其他 agent 调用。

## 为什么需要

agent 调用 agent（sub-agent）、handler 注入 agent、reactLoop 加载 agent 时都需要按名查找 agent 元数据（`filePath` / `systemPrompt` / `tools` / `agents` / `maxTurns` 等）。agent 声明运行时化后，`faapi-agents.js` 只是定位清单（`SerializedAgentRecord[]`：name / filePath / inputTypeName），不含声明数据——`createAppBase` 启动时经 `loadAndHydrateAgents` 逐个动态 import handler 模块求值 `config` 导出并校验，产出的 `AgentMetadata[]` 才进注册表。

与 [toolRegistry](./toolRegistry.md) 对称——实例级 + 全量替换，避免传递引用。agent 运行时（`@faapi/agent` 子包）和 faapi 核心的 agent 注入器都能直接 import 此模块访问。

三个扩展能力对应 agent 三类用法：

| 能力 | 用法 | 对应 API |
| --- | --- | --- |
| agent 作为 tool 被 LLM 调用 | sub-agent 在父 agent 的 `agents` 列表中 | `asTool(name)` |
| 解析 agent 可用的 tool 集合 | reactLoop 给 LLM 发 tool 列表前 | `resolveAgentTools(name)` |
| 解析 agent 可调用的子 agent | reactLoop 把 sub-agent 包装为 tool 加入列表 | `resolveSubAgents(name)` |

## 使用场景

- `createAppBase` 启动时 `loadAndHydrateAgents()`（求值 + 校验 + 水合，见 [loadAgents](../agents/loadAgents.md)）
- `createDevApp.reloadAgents` 热替换时重新求值 + 水合（dev watcher 触发）
- agent 注入器（`injectParams`）按 `agent` / `agents` 参数名查找可用 agent 列表
- `@faapi/agent` 子包的 `Agent` 类按 `agent.name` 查找元数据组装 reactLoop
- `@faapi/agent` 子包的 `reactLoop` 调 `resolveAgentTools(name)` + `resolveSubAgents(name)` + `asTool()` 组装 LLM 可见 tool 列表

## 设计

### 实例级 + 全量替换

- `hydrate(agents)` —— 全量替换注册表内容（启动 + reload 调用）
- `clear()` —— 清空（app close 时调用，与 toolRegistry 对称）

全量替换而非增量注册：agent 元数据来自启动期求值结果，reload 时整体重新求值，增量追踪反而复杂（与 `hydrateToolRegistry` 同构）。

### 基础查询 API — Core/Entry 双查询模式

agent 元数据分两层接口，对应两类使用方（类型定义见 [agentTypes](../agents/agentTypes.md)）：

- **`AgentCore`** —— LLM 可见字段：`name` / `description?` / `systemPrompt?`（string 或工厂函数）/ `systemPromptFile?` / `tools?` / `agents?` / `maxTurns?` / `inputDescription?` / `vars?`。文件型 agent 与 DB-driven agent（无源文件，业务自治）都可实现此接口。
- **`AgentMetadata extends AgentCore`** —— 额外含 `filePath`（声明文件定位，产物形式）与 `inputTypeName?`（派发入参 schema 声明判据）。仅文件型 agent（启动期求值产出）有此形态。

| 方法 | 返回类型 | 用途 |
| --- | --- | --- |
| `getAgent(name)` | `AgentCore \| undefined` | LLM-facing 场景：`agents` 注入器、`asTool` 描述、`resolveAgentTools` / `resolveSubAgents` 解析。仅查文件 registry |
| `getAgentEntry(name)` | `AgentMetadata \| undefined` | 框架内部：查声明文件定位 / Input schema 判据（清单可观测性） |
| `listAgents()` | `AgentCore[]` | 返回所有已注册文件型 agent（副本，修改不影响内部状态） |

**调用方选择**：消费 LLM 可见字段的代码用 `getAgent`；需要 `filePath` / `inputTypeName` 的代码用 `getAgentEntry`。

### `asTool(name)` — agent 包装为 tool

把 agent 包装为 `AgentToolDescriptor`（与 `ToolMetadata` 平行结构），供 LLM 当作 tool 调用。

- `name` 默认 `agent-<agentName>`（由 [subAgentToolName](./subAgentToolName.md) 生成——连字符前缀满足 OpenAI 兼容协议的工具名字符集约束；执行路由不靠名字前缀猜测，由 `@faapi/agent` 的 `Agent` 类按声明集合派发）
- `description` 透传 `agent.description`
- `metadata` 持有 `AgentCore` 引用（reactLoop 取 `systemPrompt` / `maxTurns` 等）；`filePath` / `inputTypeName` 由 `@faapi/agent` 子包通过 `getAgentEntry` 单独获取
- 不含 input schema——本层只做包装；声明了 `Input` 的 agent 其派发入参 schema（parameters JSON Schema）由 `@faapi/agent` 组装层经 `resolveAgentInputSchema` 补齐（交接单字段说明取 `inputDescription`，未声明用框架默认文案）
- 未注册返回 `undefined`

reactLoop 把 `AgentToolDescriptor` 与 `ToolMetadata` 合并为统一 tool 列表发往 LLM，按 `kind` 字段路由执行（`tool` → `loadToolModule`；`agent` → sub-agent 递归）。

### `resolveAgentTools(name)` — 解析可用 tool 集合

返回 `ToolMetadata[]`，**只包含 agent 显式声明的 tool**：

- **agent 显式声明的 `tools`**：`agent.tools` 列表中的 tool 名（config 声明，启动期求值的拓扑数据），按名从 tool 注册表查找

只合并 agent 显式声明的 tool——sub-agent 的合并由 `@faapi/agent` 的 `Agent.buildToolDefinitions` 在更上层完成（按 `name` 去重）。`resolveAgentTools` 只关心 agent 自身显式声明的部分，职责单一。

`tools` 中未在 toolRegistry 找到的 tool 名静默跳过（tool 可选可用，不强制存在；plugin 可运行时注册额外 tool，故不做存在性强校验）。

agent 未注册返回空数组。

### `resolveSubAgents(name)` — 解析子 agent 集合

读 `agent.agents` 字段（config 声明，启动期求值），按名查找已注册 agent，返回 `AgentCore[]`（LLM-facing 字段，供 `@faapi/agent` 子包包装为 `AgentToolDescriptor`）。

- `agents` 引用不存在在启动期求值阶段已显式抛错（[loadAgents](../agents/loadAgents.md) 的 `validateAgentDeclarations`，错误推迟到运行时静默失败会丢构建上下文）——本层查询对未命中名仍跳过（防御：插件运行时注册的 DB-driven agent 可能与声明时序交错）
- agent 未注册返回空数组
- 返回副本，修改不影响内部状态

reactLoop 组装 LLM tool 列表：`resolveAgentTools(name)` 的 `ToolMetadata[]` + `resolveSubAgents(name).map(a => asTool(a.name))` 的 `AgentToolDescriptor[]`。

### faapi-agents.js 缺失处理

项目可能没有任何 agent（纯 API 项目）。`faapi-agents.js` 不存在时，`createAppBase` 跳过求值与水合，注册表保持空——与 `faapi-tools.js`（可选产物）对称，与 `faapi-routes.js`（必需产物）不同，agent 是可选能力。

## 跨注册表依赖

`resolveAgentTools` 依赖 [toolRegistry](./toolRegistry.md) 的 `getTool`——两个注册表协同工作，由 `createAppBase` 在同一启动阶段水合。reload 时 `reloadTools` + `reloadAgents` 都触发，保证两个注册表一致。

## 相关模块

- [loadAgents](../agents/loadAgents.md) - 启动期求值管线（`AgentMetadata[]` 的产出方，含清单级校验）
- [generateAgentArtifacts](../cli/generateAgentArtifacts.md) - 生成 `faapi-agents.js` 定位清单
- [agentTypes](../agents/agentTypes.md) - `AgentCore` / `AgentMetadata` / `AgentManifest` 类型定义
- [createAppCore](../cli/createAppCore.md) - 启动时求值 + 水合入口（`loadAndHydrateAgents`）
- [toolRegistry](./toolRegistry.md) - tool 注册表（对称模块，`resolveAgentTools` 在此按 agent.tools 解析可用 tool）
