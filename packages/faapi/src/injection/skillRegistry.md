# skillRegistry

一句话概括：运行时动态 skill 注册表单例，与 [agentRegistry](./agentRegistry.md) 物理隔离，承载 DB-driven skills（业务方在 plugin 里从数据库 / 外部源加载的 skill 元数据），**仅供业务方 plugin 内部使用**——不参与 agent 查询链路、不覆盖文件型 agent、不被 agent 自动引用。

## 为什么需要

业务方有时需要从数据库 / 外部 API 动态加载 skill 元数据（admin 面板编辑、运营配置），这类数据的特点：

- 来源是数据库 / 外部 API（不是文件系统）
- 生命周期是**运行时增量**（监听 DB change stream，单条增删改），不是启动期一次性水合
- 不能被 dev `reloadAgents` 清空（admin 改了 DB 里的 skill，dev watcher 不该把它弄丢）

skillRegistry 提供独立的运行时存储，让业务方 plugin 自行编排使用——**与 agentRegistry 物理隔离，各管各的**。

## 与 agentRegistry 的关系 — 物理隔离

**职责正交不耦合**：

- **agent 负责核心流程**：[agentRegistry](./agentRegistry.md) 承载文件型 agent（编译期 `faapi-agents.js` 产物来源），含 `run` 函数的多步 prompt 串联、文件型入口、sub-agent 递归
- **skill 用于拓展**：skillRegistry 承载运行时动态补充的 LLM 可见元数据，业务方 plugin 自行编排使用

agentRegistry 的查询函数（`getAgent` / `listAgents` / `asTool` / `resolveAgentTools` / `resolveSubAgents`）**不 fallback 到 skillRegistry**——skill 不参与 agent 查询链路、不覆盖文件型 agent、不参与 sub-agent 递归。skill 不再被 agent 的 `agents` 列表自动引用。

skill 与 agent 是补充关系而非覆盖关系——业务方在 plugin 内拿到 skill 后自行决定如何使用（如塞到自定义中间件 ctx、通过自定义注入器按名匹配、组装到 LLM 请求中等），框架核心不规定 skill 的具体使用方式。

## 使用场景

- **业务方 plugin 接入 DB-driven skills**：`lifecycle.onReady` 连数据库全量查询 skill 表 → 转成 `AgentCore[]` → `hydrateSkillRegistry`；监听 DB change stream → `upsertSkill` / `removeSkill` 增量更新
- **业务方 plugin 内部按需查询**：通过 `getSkill` / `listSkills` 读取已注册 skill,自行编排使用（如组装到自定义 LLM 调用、塞到中间件 ctx 供 handler 读取、通过自定义注入器按名注入到 handler 等）

> skill 不再通过 `agents` 参数注入到 handler、不再被 `@faapi/agent` 子包的 Agent 类自动消费。业务方需要让 handler 看到 skill 时,自行通过注入器或中间件机制注入。

## 设计

### 双 registry 物理隔离

| 维度 | agentRegistry | skillRegistry |
| --- | --- | --- |
| 来源 | 编译期 `faapi-agents.js` 产物 | 业务方运行时从 DB / 外部源加载 |
| 注入时机 | `createAppBase` 启动期 / `reloadAgents` dev 热替换 | 业务方 plugin `lifecycle.onReady` 启动期 + 运行时增量 |
| 替换语义 | 整体替换（`hydrateAgentRegistry`） | 整体替换（`hydrateSkillRegistry`）+ 单条增删（`upsertSkill` / `removeSkill`） |
| `reloadAgents` 影响 | 重新整体替换 | 不受影响（dev 模式安全） |
| 清空时机 | app close | app close（与 agentRegistry 对称） |
| 查询链路 | 供 agent 注入器 / `@faapi/agent` 子包自动消费 | 仅供业务方 plugin 内部主动调用 |

### 存储 AgentCore 而非 AgentMetadata

skillRegistry 内部存储 `AgentCore` 而非完整 `AgentMetadata`——DB skill 无源文件，无需 `filePath` / `hasRun` 等代码加载占位字段。业务方从 DB 字段直接映射到 `AgentCore` 的 LLM 可见字段：

| DB 字段（业务方自定义） | `AgentCore` 字段 |
| --- | --- |
| `name` | `name` |
| `description` | `description?` |
| `system_prompt` | `systemPrompt?` |
| `tools` | `tools?` |
| `agents` | `agents?` |
| `model` | `model?` |
| `max_turns` | `maxTurns?` |

无需像旧设计那样填 `filePath: ''` / `hasConfig: false` / `hasRun: false` 占位——这些字段属于 `AgentMetadata`（文件型 agent 专用，DB skill 不实现该接口）。

DB skill 不支持自定义 `run` 函数（多步 prompt 串联）——需要 `run` 的仍走文件型 agent。

### API

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `hydrateSkillRegistry(skills)` | `(skills: AgentCore[]) => void` | 整体替换（业务方 plugin `onReady` 启动期一次性灌入） |
| `upsertSkill(core)` | `(core: AgentCore) => void` | 单条增改（运行时监听 DB change stream 用；`Map.set` 原子，并发安全） |
| `removeSkill(name)` | `(name: string) => void` | 单条删（运行时 DB 删除记录时调） |
| `getSkill(name)` | `(name: string) => AgentCore \| undefined` | 按名查单个（未找到返回 `undefined`） |
| `listSkills()` | `() => AgentCore[]` | 返回所有已注册 skill（副本） |
| `clearSkillRegistry()` | `() => void` | 清空（app close 时调用，与 `clearAgentRegistry` 对称） |

### 不需要改造的地方

- `@faapi/agent` 子包的 `Agent` 类、`AgentHandleFactory` 不动——这些类只消费 `agentRegistry`,与 skillRegistry 无关
- `injectParams.ts` 的 `agent` / `agents` 注入器不动——它们只调 `agentRegistry`,不消费 skillRegistry
- `createAppBase` 的水合流程不动——只在 `close` 流程加 `clearSkillRegistry`

## 相关模块

- [agentRegistry](./agentRegistry.md) — 物理隔离的兄弟模块,承载文件型 agent;查询函数不 fallback 到本模块
- [toolRegistry](./toolRegistry.md) — 同构设计参考（单例 + 全量替换 + clear）；目前 DB tool 不在范围内，未来可对称扩展 `skillToolRegistry`
- `createAppBase` — app close 时调 `clearSkillRegistry`（与 `clearAgentRegistry` 对称）
