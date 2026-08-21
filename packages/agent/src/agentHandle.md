# agentHandle

一句话概括：`AgentHandle` 接口——注入到 handler 的 `agent` 参数,提供可调用的 agent 运行入口（`run` / `stream` / `asTool`）,由 [plugin](./plugin.md) 注册的工厂函数创建。

## 为什么需要

faapi 核心的 [agentHandle 工厂注册机制](../../faapi/src/injection/agentHandle.md)（Phase 3.5a/b）让核心与 agent 实现解耦：

- **核心侧**：`injectParams` 在 `agent` 参数注入时调 `getAgentHandle(ctx)`,工厂返回 `unknown`
- **本包侧**：[plugin](./plugin.md) setup 时注册工厂,工厂构造 [Agent](./agent.md) 实例

需要一个类型让 handler 拿到类型安全的调用入口——这就是 `AgentHandle`。它是一个纯接口（运行时擦除）,`Agent` 类满足此接口（结构化类型）,plugin 的工厂直接返回 `Agent` 实例,无需额外包装层。

## 使用场景

- **handler 调用 agent**：`GET(agent: AgentHandle)` → `agent.run(input)` / `agent.stream(input)`
- **agent-as-tool**：父 agent 通过 `asTool()` 把自身包装为 `AgentToolDescriptor`,加入 LLM 可见 tool 列表
- **流式 LLM 输出**：`agent.stream(input)` 配合 [SSE](../../faapi/src/runtime/sse.md) 实现聊天流式响应

## 设计

### 接口定义

```ts
interface AgentHandle {
  run(input: string): Promise<ReactLoopResult>;
  stream(input: string): AsyncIterable<ReactLoopStreamChunk>;
  asTool(): AgentToolDescriptor | undefined;
}
```

### Agent 满足 AgentHandle（结构化类型）

[Agent](./agent.md) 类的方法签名与 `AgentHandle` 完全匹配：

| AgentHandle 方法 | Agent 实现 | 说明 |
| --- | --- | --- |
| `run(input)` | `async run(input: string): Promise<ReactLoopResult>` | 组装 config → 调 reactLoop |
| `stream(input)` | `async *stream(input: string): AsyncIterable<ReactLoopStreamChunk>` | 组装 config → 调 reactLoopStream |
| `asTool()` | `asTool(): AgentToolDescriptor \| undefined` | 包装为 tool 描述符 |

因此 plugin 的工厂直接 `return new Agent(deps)`,TS 结构化类型自动判定满足 `AgentHandle`。

### 注入流程

```
faapi.config.ts 配置 agent.llm + agent.defaultAgent
         ↓
@faapi/agent plugin setup()
  ├─ 读 config.agent.llm → createProvider → LLMProvider 实例
  ├─ 读 config.agent.defaultAgent / maxTurns / maxAgentDepth / defaultTools
  ├─ 从 @faapi/faapi import 注册表/加载器访问器（getAgent / getTool / resolveAgentTools / resolveSubAgents / loadAgentModule / loadToolModule）
  └─ registerAgentHandleFactory((ctx) => {
       return new Agent({ provider, agentName: defaultAgent, rootDir, config, getAgent, ... });
     })
         ↓
handler GET(agent: AgentHandle)
  └─ injectParams case 'agent' → getAgentHandle(ctx) → 工厂返回 Agent 实例
         ↓
agent.run(input) / agent.stream(input)
```

### 工厂未注册时的行为

工厂未注册（`@faapi/agent` 插件未加载或 `config.agent.llm` / `defaultAgent` 未配置）时,`getAgentHandle(ctx)` 返回 `undefined`,handler 的 `agent` 参数为 `undefined`。handler 需自行处理此情况（如返回 503 错误）。

## 相关模块

- [agent](./agent.md) —— Agent 类,满足 AgentHandle 接口
- [plugin](./plugin.md) —— @faapi/agent faapi 插件,注册工厂函数
- [reactLoop](./reactLoop.md) —— run / stream 委托给的循环引擎
- faapi 核心 [agentHandle 工厂](../../faapi/src/injection/agentHandle.md) —— 工厂注册/查询/清理机制
- faapi 核心 [injectParams](../../faapi/src/injection/injectParams.md) —— `agent` 参数注入点
