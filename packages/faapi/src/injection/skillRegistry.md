# skillRegistry

一句话概括：运行时动态 skill 注册表单例，与 [agentRegistry](./agentRegistry.md) 物理隔离，承载 DB-driven skills（业务方在 plugin 里从数据库 / 外部源加载的 skill 元数据），供 `@faapi/agent` 的 `Agent` 类通过 `agentRegistry` 查询入口 fallback 自动发现。

## 为什么需要

[agentRegistry](./agentRegistry.md) 的设计语义是「**编译期产物一次性水合**」——`hydrateAgentRegistry(agents)` 全量替换 Map，来源是构建期生成的 `faapi-agents.js` 清单。dev 模式下 `reloadAgents` 会重新整体替换，清空运行时新增的内容。

DB-driven skills 场景与编译期产物正交：

- 来源是数据库 / 外部 API（admin 面板编辑、运营配置），不是文件系统
- 生命周期是**运行时增量**（监听 DB change stream，单条增删改），不是启动期一次性水合
- 不能被 dev `reloadAgents` 清空（admin 改了 DB 里的 skill，dev watcher 不该把它弄丢）
- DB skill 名可能与文件型 agent 重名（业务方需要覆盖），但两者来源不同——物理隔离比同表 name 冲突规则更清晰

把 DB skill 塞进 `agentRegistry` 会让两类来源混在一个 Map 里：`reloadAgents` 会清空 DB skill（dev 模式每次改文件都触发，需要业务方在 reload 后重新塞），且 `hydrate` 整体替换语义与「运行时增量」天然冲突。

独立 `skillRegistry` 让两类来源物理隔离、API 语义清晰：

- `hydrateAgentRegistry` = 编译期产物一次性灌入（framework 调）
- `upsertSkill` / `removeSkill` = 运行时动态增删（业务方调）
- 互不干扰，dev `reloadAgents` 只动文件型 registry，不影响 skillRegistry

## 使用场景

- **业务方 plugin 接入 DB-driven skills**：`lifecycle.onReady` 连数据库全量查询 skill 表 → 转成 `AgentCore[]` → `hydrateSkillRegistry`；监听 DB change stream → `upsertSkill` / `removeSkill` 增量更新
- **`@faapi/agent` 的 `Agent` 类自动发现 skill**：`agentRegistry.getAgent(name)` 先查 skillRegistry 后查文件 registry——业务方 hydrate 的 DB skill 自动被注入器、Agent 类发现，无需改 `@faapi/agent` 子包
- **handler 注入 `agent` 参数**：业务方 handler 的 `agent: AgentHandle | undefined` 参数自动能拿到 DB skill（通过 @faapi/agent plugin 注册的工厂，工厂调 `agentRegistry.getAgent` fallback 命中 skill）
- **handler 注入 `agents` 参数**：返回文件型 agent + DB skill 的合并列表（去重，skill 优先）
- **sub-agent 递归**：DB skill 可被文件型 agent 通过 `agents: ['xxx']` 引用（fallback 到 skillRegistry）

## 设计

### 双 registry 物理隔离

| 维度 | agentRegistry | skillRegistry |
| --- | --- | --- |
| 来源 | 编译期 `faapi-agents.js` 产物 | 业务方运行时从 DB / 外部源加载 |
| 注入时机 | `createAppBase` 启动期 / `reloadAgents` dev 热替换 | 业务方 plugin `lifecycle.onReady` 启动期 + 运行时增量 |
| 替换语义 | 整体替换（`hydrateAgentRegistry`） | 整体替换（`hydrateSkillRegistry`）+ 单条增删（`upsertSkill` / `removeSkill`） |
| `reloadAgents` 影响 | 重新整体替换 | 不受影响（dev 模式安全） |
| 清空时机 | app close | app close（与 agentRegistry 对称） |

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

无需像旧设计那样填 `filePath: ''` / `hasConfig: false` / `hasRun: false` 占位——这些字段属于 `AgentMetadata`（文件型 agent 专用，DB skill 不实现该接口）。`agentRegistry.getAgent` fallback 到本 registry 时返回 `AgentCore`，与文件 registry 的 `AgentCore` 同构合并。

DB skill 不支持自定义 `run` 函数（多步 prompt 串联）——覆盖 80% 的「配置 + tool 组合」场景，需要 `run` 的仍走文件型 agent。

### API

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `hydrateSkillRegistry(skills)` | `(skills: AgentCore[]) => void` | 整体替换（业务方 plugin `onReady` 启动期一次性灌入；与 `hydrateAgentRegistry` 同构） |
| `upsertSkill(core)` | `(core: AgentCore) => void` | 单条增改（运行时监听 DB change stream 用；`Map.set` 原子，并发安全） |
| `removeSkill(name)` | `(name: string) => void` | 单条删（运行时 DB 删除记录时调） |
| `getSkill(name)` | `(name: string) => AgentCore \| undefined` | 按名查单个（未找到返回 `undefined`） |
| `listSkills()` | `() => AgentCore[]` | 返回所有已注册 skill（副本） |
| `clearSkillRegistry()` | `() => void` | 清空（app close 时调用，与 `clearAgentRegistry` 对称） |

### agentRegistry 查询入口 fallback

`agentRegistry` 的查询函数增加 fallback 到 `skillRegistry`：

| agentRegistry 方法 | 返回类型 | fallback 行为 |
| --- | --- | --- |
| `getAgent(name)` | `AgentCore \| undefined` | 先查 `getSkill(name)`，命中返回；未命中查文件 registry |
| `getAgentEntry(name)` | `AgentMetadata \| undefined` | **不 fallback**——DB skill 无文件，不走 `loadAgentModule`；仅查文件 registry |
| `listAgents()` | `AgentCore[]` | 合并文件型 + skill，按 `name` 去重（重名时 skill 优先覆盖文件型） |
| `resolveAgentTools(name)` | `ToolMetadata[]` | fallback 命中 skill 时返回其 `tools` 引用列表 |
| `resolveSubAgents(name)` | `AgentCore[]` | fallback 命中 skill 时返回其 `agents` 列表 |
| `asTool(name)` | `AgentToolDescriptor \| undefined` | fallback 命中 skill 时把 skill 包装为 `AgentToolDescriptor` |

**fallback 优先级**：skillRegistry > agentRegistry（同名时 skill 覆盖文件型 agent）。这给业务方提供 override 能力——例如业务方在 DB 里覆盖一个文件型 agent 的 systemPrompt，只 hydrate 到 skillRegistry 即可，不修改源码。

**`getAgentEntry` 不 fallback 的原因**：DB skill 无源文件，没有 `filePath` / `hasRun`，自然不通过 `loadAgentModule` 加载。`@faapi/agent` 子包加载 `handler.js` 执行 `run` 函数时只能走文件 registry；消费 LLM 可见字段的代码（`systemPrompt` / `tools` / `agents` / `model` / `maxTurns`）应改用 `getAgent`，自动命中 DB skill。

### 不需要改造的地方

- `@faapi/agent` 子包的 `Agent` 类、`AgentHandleFactory` 不动——`Agent` 类调 `agentRegistry.getAgent` / `resolveAgentTools` / `resolveSubAgents`，fallback 自动生效
- `injectParams.ts` 的 `agent` / `agents` 注入器不动——`getAgent` / `listAgents` 的 fallback 自动覆盖
- `createAppBase` 的水合流程不动——只在 `close` 流程加 `clearSkillRegistry`

## 相关模块

- [agentRegistry](./agentRegistry.md) — 查询入口在 `getAgent` / `listAgents` / `resolveAgentTools` / `resolveSubAgents` / `asTool` 中 fallback 到本模块
- [toolRegistry](./toolRegistry.md) — 同构设计参考（单例 + 全量替换 + clear）；目前 DB tool 不在范围内，未来可对称扩展 `skillToolRegistry`
- [agentHandle](./agentHandle.md) — `AgentHandleFactory` 调 `agentRegistry.getAgent` fallback 自动发现 skill
- `createAppBase` — app close 时调 `clearSkillRegistry`（与 `clearAgentRegistry` 对称）
- `@faapi/agent` 子包 — `Agent` 类通过 `agentRegistry.getAgent` / `resolveAgentTools` / `resolveSubAgents` 自动消费 skill，无需改造
