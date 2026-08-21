# injectParams

一句话概括：根据注入信息，准备参数值并调用 handler。

## 为什么需要

`resolveInjection` 分析出需要注入什么，`injectParams` 负责准备对应的值并按正确顺序传给 handler。

## 使用场景

- 路由 handler 调用前准备参数
- 根据 context 提取 query、body、headers 等
- 执行参数校验
- 注入 agent 元数据（Phase 2.3 扩展）

## 内置注入处理（Phase 2.3 扩展）

| 注入类型 | 处理 | 返回值 |
| --- | --- | --- |
| `query` / `params` / `headers` / `context` / `cookies` / `ip` / `ua` / `body` / `form` / `files` / `fields` | 同步从 ctx/body 取值 | 见 `getBuiltinInjectionValue` |
| `agents` | 同步从 [agentRegistry](./agentRegistry.md) 取值 | `AgentMetadata[]`（所有已注册 agent） |
| `agent` | 暂不处理（Phase 2.4 实现） | `undefined` |

`agent` / `agents` 注入在 Phase 2.3 添加：
- `agents` → `listAgents()` —— 注入所有 agent 元数据列表，handler 可遍历查询可用 agent
- `agent` → `undefined` —— Phase 2.4 实现 `config.defaultAgent` 后注入默认 agent 元数据

Phase 3.x 的 `@faapi/agent` 插件通过 `faapi.config.ts` 的 `injectors` 注册 `agent` / `agents` 注入器，覆盖内置的元数据注入，提供 `AgentHandle`（含可调用 `run` 函数）。

## 注入优先级

内置注入优先于注入器（避免 `query` / `body` 等被覆盖）。但 `agent` 注入类型暂返回 `undefined`，业务方需通过注入器机制提供 AgentHandle 实例——内置占位，注入器覆盖。

## 相关模块

- `resolveInjection.ts` - 提供注入信息
- `validateInput.ts` - 参数校验
- `agentRegistry.ts` - agent 元数据来源（`listAgents`）
