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
    llms: {
      openai: {
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: 'https://api.openai.com/v1', // 可选,默认 OpenAI 官方
        models: {
          'gpt-4o': {},
          'gpt-4o-mini': { temperature: 0.5 },
        },
      },
    },
    defaultLlm: 'openai', // 可选,未设置时用 llms 第一个 key
    defaultAgent: 'researcher',
    maxTurns: 10,
    maxAgentDepth: 3,
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
2. 检查 agentConfig.llms → 缺失时 warn + return（defaultAgent 可选）
3. 遍历 agentConfig.llms → 每项调 createProvider → Map<providerKey, LLMProvider>
4. 读 agentConfig.defaultLlm → defaultProvider（未设时用 llms 第一个 key）
5. 读 agentConfig.defaultAgent（可选,未设时为空字符串）
6. 构造 AgentRuntimeConfig（maxTurns / maxAgentDepth）
7. registerAgentHandleFactory(() => new Agent({ providers, defaultProvider, llms, defaultLlm, agentName, rootDir, config, ...accessors }))
```

### 工厂函数

工厂签名：`(ctx: FaapiContext) => unknown`

工厂每次请求时被 `injectParams` 调用,构造一个新的 [Agent](./agent.md) 实例：

```ts
// setup 内创建一次，工厂内复用（避免每次请求重建闭包）
const resolveToolSchema = (tool) => resolveToolSchemaImpl(tool, rootDir);

registerAgentHandleFactory(() => {
  return new Agent({
    providers,                   // 闭包捕获（setup 时创建,Map<providerKey, LLMProvider>）
    defaultProvider,             // 闭包捕获（默认 provider 实例）
    llms,                        // 闭包捕获（agentConfig.llms,供 Agent 按名查找 LlmConfig）
    defaultLlm,                  // 闭包捕获（默认 provider key）
    agentName: defaultAgent,     // 闭包捕获（config.agent.defaultAgent）
    rootDir,                     // 闭包捕获（ctx.rootDir）
    config: runtimeConfig,      // 闭包捕获（maxTurns / maxAgentDepth）
    getAgent,                    // 从 @faapi/faapi import（单例模块）
    getAgentEntry,               // 从 @faapi/faapi import（用于加载 handler.js 执行 run 函数）
    getTool,
    resolveAgentTools,
    resolveSubAgents,
    loadToolModule: (filePath, functionName) =>
      loadToolModule(filePath, functionName, rootDir),  // 包装注入 rootDir
    loadAgentModule: (filePath, hasRun) =>
      loadAgentModule(filePath, hasRun, rootDir),  // 包装注入 rootDir
    resolveToolSchema,           // setup 内创建的偏函数（工厂内复用）
  });
});
```

**为什么 Agent 每次请求新建**：Agent 构造轻量（仅存 deps）,实际 LLM 调用在 `run` / `stream` 时才发生。每次请求新建避免跨请求状态泄漏（如 conversation history）。

**为什么 provider 是单例**：provider 持有 HTTP 连接池 / API key,创建成本高,所有请求共享。工厂闭包捕获 setup 时创建的 provider Map。

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
| `config.agent.llms` 未设置 | warn + return,不注册工厂 |
| `config.agent.defaultAgent` 未设置 | 正常注册,`deps.agentName` 为空字符串,handler 需 `agent.run(input, { agent: 'name' })` 显式指定 |
| `config.agent.defaultLlm` 未设置 | 正常注册,用 `llms` 第一个 key 作默认 |
| `config.agent.defaultLlm` 指向不存在的 key | warn + return,不注册工厂 |
| `config.agent.maxTurns` 未设置 | 正常注册,Agent 用 agent 自身 maxTurns |
| `config.agent.maxAgentDepth` 未设置 | 正常注册,Agent 用默认值 3 |

工厂未注册时,[getAgentHandle](../../faapi/src/injection/agentHandle.md) 返回 `undefined`,handler 的 `agent` 参数为 `undefined`。
`defaultAgent` 未设置但工厂已注册时,`agent` 参数不为 `undefined`——Agent 实例正常注入,但 `agent.run(input)` 不传 `{ agent }` 时抛 `AgentError`。

### resolveToolSchema 实现

`resolveToolSchemaImpl` 是模块级函数（非 setup 内闭包）——setup 时用 `rootDir` 偏函数绑定一次,工厂内直接复用,避免每次请求重建闭包。

它加载 tool 的 `zod.js`（由 faapi 核心 [loadToolSchema](../../faapi/src/loader/loadToolSchema.md) 加载），用 zod v4 内置的 `z.toJSONSchema` 生成 JSON Schema 发给 LLM，`schema.safeParse` 校验 LLM 返回的参数：

- `jsonSchema`：`z.toJSONSchema(schema)` → tool 参数的 JSON Schema（发给 LLM）
- `validate`：`schema.safeParse(input)` → 成功返回 coerce 后的 value，失败返回 error 消息

> Agent 类内部按 `tool.name` 缓存 schema 解析结果（[agent.md](./agent.md) 的 schema 缓存章节）,`buildToolDefinitions` 与 `executeTool` 共用——`resolveToolSchemaImpl` 对同一 tool 只被调用一次。

校验失败时 `executeTool` 返回 `{ error }` 对象（不调 handler），reactLoop stringify 后回传 LLM 重试。

zod.js 缺失（tool 无 `inputTypeName` 或 `zod.js` 不存在）时 `loadToolSchema` 返回 `undefined`，`resolveToolSchemaImpl` 也返回 `undefined`，agent 用自由 schema `{ type: 'object' }`，LLM 自由传参。

## 相关模块

- [agent](./agent.md) —— Agent 类,工厂返回的实例
- [agentHandle](./agentHandle.md) —— AgentHandle 接口,Agent 满足此接口
- [provider](./provider.md) —— LLM provider 抽象 + createProvider 工厂
- faapi 核心 [agentHandle 工厂](../../faapi/src/injection/agentHandle.md) —— registerAgentHandleFactory / getAgentHandle
- faapi 核心 [agentRegistry](../../faapi/src/injection/agentRegistry.md) / [toolRegistry](../../faapi/src/injection/toolRegistry.md) —— 注册表访问器
- faapi 核心 [loadAgentModule](../../faapi/src/loader/loadAgentModule.md) / [loadToolModule](../../faapi/src/loader/loadToolModule.md) —— 动态加载器
