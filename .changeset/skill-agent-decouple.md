---
'@faapi/faapi': minor
'@faapi/agent': minor
---

skill 与 agent 物理隔离：移除 agentRegistry 对 skillRegistry 的 fallback

## 变更说明

skill 与 agent 职责正交不耦合,重新明确分工：

- **agent 负责核心流程**：含 `run` 函数的多步 prompt 串联、文件型入口、sub-agent 递归
- **skill 用于拓展**：运行时动态补充的 LLM 可见元数据,业务方 plugin 自行编排使用

## 破坏性变更

`agentRegistry` 的查询函数（`getAgent` / `listAgents` / `asTool` / `resolveAgentTools` / `resolveSubAgents`）**不再 fallback 到 `skillRegistry`**：

- `getAgent(name)` 仅查文件 registry,不再先查 skillRegistry
- `listAgents()` 只返回文件型 agent,不再合并 skillRegistry（同名时 skill 不再覆盖文件型 agent）
- `resolveSubAgents(name)` 不再 fallback 命中 skill——父 agent 的 `agents` 列表只能引用文件型 agent,skill 不参与 sub-agent 递归
- `asTool(name)` / `resolveAgentTools(name)` 同样不 fallback 到 skillRegistry

## 业务方影响

- `agents` 参数注入（`agentRegistry.listAgents()`）现在只返回文件型 agent,不再包含 DB-driven skill
- DB skill 不再被 `@faapi/agent` 子包的 Agent 类自动消费、不再被 agent 的 `agents` 列表自动引用
- 业务方需要让 handler 看到 skill 时,自行通过注入器或中间件机制注入（如 `getSkill(name)` 查询后塞到 ctx,通过 `injectors` 按参数名匹配注入）

## 未变更

- `skillRegistry` API（`hydrateSkillRegistry` / `upsertSkill` / `removeSkill` / `getSkill` / `listSkills` / `clearSkillRegistry`）保持不变
- `@faapi/agent` 子包的 `Agent` 类、`AgentHandleFactory` 逻辑不变（只消费 `agentRegistry`）
- `injectParams.ts` 的 `agent` / `agents` 注入器逻辑不变（只调 `agentRegistry`）
- `createAppBase` 的水合流程不变（只在 close 时调 `clearSkillRegistry`）

## 升级指南

依赖 `getAgent` fallback 命中 DB skill 的业务方需要改写：原本直接 `getAgent('translator')` 能命中 DB skill 的代码,现在返回 `undefined`。改用 `getSkill('translator')` 直接查询 `skillRegistry`,并通过自定义注入器或中间件把 skill 注入到 handler。
