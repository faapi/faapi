# injectParams

一句话概括：根据注入信息，准备参数值并调用 handler。

## 为什么需要

`resolveInjection` 分析出需要注入什么，`injectParams` 负责准备对应的值并按正确顺序传给 handler。

## 使用场景

- 路由 handler 调用前准备参数
- 根据 context 提取 query、body、headers 等
- 执行参数校验
- 注入 agent 元数据（Phase 2.3 扩展）

## 内置注入处理

| 注入类型 | 处理 | 返回值 |
| --- | --- | --- |
| `query` / `params` / `headers` / `context` / `cookies` / `ip` / `ua` / `body` / `form` / `files` / `fields` | 同步从 ctx/body 取值 | 见 `getBuiltinInjectionValue` |
| `agents` | 同步从 [agentRegistry](./agentRegistry.md) 取值 | `AgentCore[]`（所有已注册 agent 的 LLM 可见元数据，合并文件型 + DB skill） |
| `agent` | 调 [agentHandle](./agentHandle.md) 工厂 `getAgentHandle(ctx)` 取值 | `AgentHandle` 实例（`@faapi/agent` 插件未注册时返回 `undefined`） |

`agent` / `agents` 注入的行为：
- `agents` → `listAgents()` —— 注入所有 agent LLM 可见元数据列表（`AgentCore[]`），handler 可遍历查询可用 agent
- `agent` → `getAgentHandle(ctx)` —— 通过 [agentHandle](./agentHandle.md) 工厂机制注入 `AgentHandle`（含可调用 `run`/`stream`/`asTool`）

`@faapi/agent` 插件在 setup 时调 `registerAgentHandleFactory` 注册工厂,工厂在每次请求时构造 [Agent](../../agent/src/agent.md) 实例作为 `AgentHandle` 返回。未注册工厂时返回 `undefined`。

## 注入优先级

内置注入优先于注入器（避免 `query` / `body` 等被覆盖）。`agent` 注入通过 [agentHandle](./agentHandle.md) 的工厂注册机制实现（核心提供注册点，`@faapi/agent` 插件提供工厂），不通过注入器机制。

## 相关模块

- `resolveInjection.ts` - 提供注入信息
- `validateInput.ts` - 参数校验
- `agentRegistry.ts` - agent 元数据来源（`listAgents`）
