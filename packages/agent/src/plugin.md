# plugin

一句话概括：`@faapi/agent` 的 faapi 插件——setup 时读 `config.agent`、创建 LLM provider、注册 agent handle 工厂,让 handler 的 `agent` 参数注入可用的 [Agent](./agent.md) 实例。

## 为什么需要

faapi 核心与 `@faapi/agent` 解耦——核心只提供 [agentHandle 工厂注册机制](../../faapi/src/injection/agentHandle.md)（`registerAgentHandleFactory` / `getAgentHandle` / `clearAgentHandleFactory`）,不依赖 agent 实现。需要一个组件把这两端粘合起来：

- **读配置**——从 `faapi.config.ts` 的 `agent` 块读取 LLM 配置、默认 agent 名、全局参数
- **创建 provider**——调 [createProvider](./provider.md) 构造 LLM provider 实例（单例）
- **注册工厂**——调 `registerAgentHandleFactory` 注册工厂函数,工厂在每次请求时构造 [Agent](./agent.md) 实例
- **注入访问器**——从 `@faapi/faapi` import 注册表/加载器访问器（`getAgent` / `getTool` / `resolveAgentTools` / `resolveSubAgents` / `loadAgentModule` / `loadToolModule`）,构造 `AgentDeps` 注入到 Agent

插件把这些「接线」逻辑集中在一处,Agent 类保持纯运行时逻辑。

## 使用场景

```ts
// faapi.config.ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  agent: {
    llm: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o' },
    defaultAgent: 'researcher',
    maxTurns: 10,
  },
  plugins: ['@faapi/agent'],
} satisfies FaapiConfig;
```

```ts
// src/api/chat/handler.ts
import type { AgentHandle } from '@faapi/agent';

export function POST(agent: AgentHandle, body: { input: string }) {
  const result = await agent.run(body.input);
  return { content: result.content, turns: result.turns };
}
```

## 设计

### setup 流程

```
PluginContext { config.agent, rootDir }
         ↓
1. readAgentConfig(ctx) → AgentConfig | undefined
2. 检查 agentConfig.llm / agentConfig.defaultAgent → 缺失时 warn + return
3. createProvider(agentConfig.llm) → LLMProvider 实例（单例）
4. 构造 AgentRuntimeConfig（maxTurns / maxAgentDepth / defaultTools）
5. registerAgentHandleFactory(() => new Agent({ provider, agentName, rootDir, config, ...accessors }))
```

### 工厂函数

工厂签名：`(ctx: FaapiContext) => unknown`

工厂每次请求时被 `injectParams` 调用,构造一个新的 [Agent](./agent.md) 实例：

```ts
registerAgentHandleFactory(() => {
  return new Agent({
    provider,                    // 闭包捕获（setup 时创建,单例）
    agentName: defaultAgent,     // 闭包捕获（config.agent.defaultAgent）
    rootDir,                     // 闭包捕获（ctx.rootDir）
    config: runtimeConfig,      // 闭包捕获（maxTurns / maxAgentDepth / defaultTools）
    getAgent,                    // 从 @faapi/faapi import（单例模块）
    getTool,
    resolveAgentTools,
    resolveSubAgents,
    loadToolModule: (filePath, functionName) =>
      loadToolModule(filePath, functionName, rootDir),  // 包装注入 rootDir
    loadAgentModule: (filePath, hasConfig, hasRun) =>
      loadAgentModule(filePath, hasConfig, hasRun, rootDir),  // 包装注入 rootDir
  });
});
```

**为什么 Agent 每次请求新建**：Agent 构造轻量（仅存 deps）,实际 LLM 调用在 `run` / `stream` 时才发生。每次请求新建避免跨请求状态泄漏（如 conversation history）。

**为什么 provider 是单例**：provider 持有 HTTP 连接池 / API key,创建成本高,所有请求共享。工厂闭包捕获 setup 时创建的 provider 实例。

### 加载器 rootDir 包装

[loadToolModule](../../faapi/src/loader/loadToolModule.md) / [loadAgentModule](../../faapi/src/loader/loadAgentModule.md) 的第三个参数 `rootDir` 用于 dev 按需编译模式（Vite 风格）——确保产物存在再 import,避免污染 Vite SSR 内部状态。

`AgentDeps.loadToolModule` 签名不含 `rootDir`（Agent 类不需要知道编译细节）,因此在 plugin 中包装注入：

```ts
loadToolModule: (filePath, functionName) => loadToolModule(filePath, functionName, rootDir)
```

### 配置缺失处理

| 缺失项 | 行为 |
| --- | --- |
| `config.agent` 整块未设置 | warn + return,不注册工厂 |
| `config.agent.llm` 未设置 | warn + return,不注册工厂 |
| `config.agent.defaultAgent` 未设置 | warn + return,不注册工厂 |
| `config.agent.maxTurns` 未设置 | 正常注册,Agent 用 agent 自身 maxTurns |
| `config.agent.maxAgentDepth` 未设置 | 正常注册,Agent 用默认值 3 |

工厂未注册时,[getAgentHandle](../../faapi/src/injection/agentHandle.md) 返回 `undefined`,handler 的 `agent` 参数为 `undefined`。

### resolveToolSchema 实现

`AgentDeps.resolveToolSchema` 加载 tool 的 `zod.js`（由 faapi 核心 [loadToolSchema](../../faapi/src/loader/loadToolSchema.md) 加载），用 zod v4 内置的 `z.toJSONSchema` 生成 JSON Schema 发给 LLM，`schema.safeParse` 校验 LLM 返回的参数：

- `jsonSchema`：`z.toJSONSchema(schema)` → tool 参数的 JSON Schema（发给 LLM）
- `validate`：`schema.safeParse(input)` → 成功返回 coerce 后的 value，失败返回 error 消息

校验失败时 `executeTool` 返回 `{ error }` 对象（不调 handler），reactLoop stringify 后回传 LLM 重试。

zod.js 缺失（tool 无 `inputTypeName` 或 `zod.js` 不存在）时 `loadToolSchema` 返回 `undefined`，`resolveToolSchema` 也返回 `undefined`，agent 用自由 schema `{ type: 'object' }`，LLM 自由传参。

## 相关模块

- [agent](./agent.md) —— Agent 类,工厂返回的实例
- [agentHandle](./agentHandle.md) —— AgentHandle 接口,Agent 满足此接口
- [provider](./provider.md) —— LLM provider 抽象 + createProvider 工厂
- faapi 核心 [agentHandle 工厂](../../faapi/src/injection/agentHandle.md) —— registerAgentHandleFactory / getAgentHandle
- faapi 核心 [agentRegistry](../../faapi/src/injection/agentRegistry.md) / [toolRegistry](../../faapi/src/injection/toolRegistry.md) —— 注册表访问器
- faapi 核心 [loadAgentModule](../../faapi/src/loader/loadAgentModule.md) / [loadToolModule](../../faapi/src/loader/loadToolModule.md) —— 动态加载器
