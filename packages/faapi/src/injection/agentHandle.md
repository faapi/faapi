# agentHandle

一句话概括：agent handle 工厂注册表——让 `@faapi/agent` 插件在启动时注册「请求级 agent handle 工厂」，`injectParams` 在 `agent` 参数注入时调工厂拿到 `AgentHandle` 实例。

## 为什么需要

[injectParams](../injection/injectParams.md) 的 `agent` 参数注入需要返回一个 `AgentHandle`（含可调用 `run` / `stream`）。但 faapi 核心不依赖 `@faapi/agent`——核心不知道 `Agent` 类、`LLMProvider` 等概念。

需要一个解耦机制：

- **核心提供注册点**——`registerAgentHandleFactory` 让 `@faapi/agent` 插件在 setup 时注册工厂
- **核心提供查询点**——`getAgentHandle` 让 `injectParams` 在 `agent` 参数注入时调工厂
- **类型擦除**——工厂返回 `unknown`，核心不关心具体类型；handler 通过 `import type { AgentHandle } from '@faapi/agent'` 拿到类型

与 [agentRegistry](./agentRegistry.md) / [toolRegistry](./toolRegistry.md) 对称——单例注册表，生命周期与 app 一致。

## 使用场景

- **`@faapi/agent` 插件 setup**：创建 `Agent` 实例 → 调 `registerAgentHandleFactory(() => agent)` 注册
- **`injectParams` agent 参数注入**：调 `getAgentHandle(ctx)` 拿 `AgentHandle`，未注册时返回 `undefined`
- **app close**：调 `clearAgentHandleFactory()` 清理（避免测试间状态泄漏）

## 设计

### 工厂签名

```ts
type AgentHandleFactory = (ctx: FaapiContext) => unknown;
```

- 接收 `FaapiContext`——工厂可选择使用请求级信息（如 `ctx.config` 中的动态配置）
- 返回 `unknown`——核心不关心具体类型；`@faapi/agent` 插件返回 `Agent` 实例（满足 `AgentHandle` 接口）

### 单例与生命周期

| 时机 | 操作 |
| --- | --- |
| 插件 setup | `registerAgentHandleFactory(factory)` |
| 每次请求 `agent` 参数注入 | `getAgentHandle(ctx)` |
| app close / reload | `clearAgentHandleFactory()` |

与 `agentRegistry` / `toolRegistry` 同构——模块级变量存储，全量替换而非增量注册。

### 为什么不用注入器机制

[injectParams](../injection/injectParams.md) 的注入器（`InjectorMap`）按参数名匹配，但内置注入优先于注入器。`agent` 已映射为内置注入类型（`PARAM_TYPE_MAP.agent = 'agent'`），注入器无法覆盖。

工厂注册机制是更直接的解耦方式——核心控制注入流程，插件提供工厂，无需改注入优先级。

## 相关模块

- [injectParams](../injection/injectParams.md) —— `agent` 参数注入调 `getAgentHandle`
- [agentRegistry](./agentRegistry.md) —— agent 元数据查询（插件构造 `AgentDeps` 时用）
- [toolRegistry](./toolRegistry.md) —— tool 元数据查询
- `@faapi/agent` 插件 —— setup 时注册工厂，创建 `Agent` 实例
