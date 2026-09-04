# 场景：Agent 与 Tool 开发

## 何时加载

用户要写 agent handler、tool handler、配置多 agent 协作、用 LLM 驱动业务逻辑，或排查 agent 相关问题时。

## 前置依赖

```bash
pnpm add @faapi/faapi @faapi/agent zod@^4
```

`@faapi/agent` 是可选扩展（独立包），未安装时 agent 子系统不工作，handler 的 `agent` 参数注入 `undefined`。`zod` 是 peerDependency，框架生成的 `zod.js` 在业务方项目目录执行，需项目根 `node_modules` 可解析到 zod。

## 启用 agent 子系统

在 `faapi.config.ts` 声明 agent 全局配置 + 启用 `@faapi/agent` 插件：

```ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  agent: {
    // llms 是嵌套级联结构：provider 在外层，model 挂在 models 下
    llms: {
      openai: {
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: 'https://api.openai.com/v1',       // 可选，OpenAI 兼容 API
        // provider 级透传字段（如 temperature），所有 model 共享
        temperature: 0.7,
        models: {
          'gpt-4o': {},                              // 用 provider 级默认
          'gpt-4o-mini': { temperature: 0.5 },      // model 级覆盖同名字段
        },
      },
      // 可声明多个 provider，用 defaultLlm 选默认
      // anthropic: {
      //   provider: 'anthropic',
      //   apiKey: process.env.ANTHROPIC_API_KEY,
      //   models: { 'claude-3-5-sonnet': {} },
      // },
    },
    defaultLlm: 'openai',                            // 默认 provider key（未设时用 llms 第一个 key）
    defaultAgent: 'researcher',                      // 可选——未设时 handler 需 agent.run(input, { agent: 'name' }) 显式指定
    maxTurns: 10,
    maxAgentDepth: 3,
    // enableTracing: true,                          // 启用 tracing（默认 false——opt-in,不开启零开销;需要观测的端点显式开启）
  },
  plugins: ['@faapi/agent'],
} satisfies FaapiConfig;
```

| 字段 | 说明 | 缺失行为 |
|------|------|---------|
| `llms` | LLM provider 配置映射（key 是 provider 名，值含 `models`） | 不注册工厂，`agent` 参数注入 `undefined` |
| `defaultLlm` | 默认 provider key（未设时用 `llms` 第一个 key） | 用 `Object.keys(llms)[0]` |
| `defaultAgent` | 默认 agent 名（可选，`agent` 参数注入时作为 `agent.run` 的缺省 agent） | 正常注册工厂，`deps.agentName` 为空字符串——handler 需 `agent.run(input, { agent: 'name' })` 显式指定，不传且未设时抛 `AgentError` |
| `maxTurns` | 默认最大对话轮数 | agent 自身 `config.maxTurns` 优先，都无时用框架默认 |
| `maxAgentDepth` | agent 调用 agent 的最大递归深度（默认 3） | 用框架默认 3 |
| `enableTracing` | 启用结构化 trace（默认 false——opt-in,详见「Tracing」章节） | 用默认 false（零开销） |

**嵌套级联**：provider 级字段（`apiKey` / `baseURL` / `temperature` 等）共享给所有 model；model 级字段在 `models[modelName]` 里覆盖 provider 级同名字段。空对象 `{}` 表示用 provider 级默认。

`llms.<provider>.apiKey` 等通过 `process.env.XXX` 读取，配合 `.env` 文件管理敏感值，详见 [multi-env.md](./multi-env.md)。

## 目录结构

```
src/
├── api/                          ← HTTP 路由
│   └── chat/handler.ts           ← handler 用 `agent` 参数注入
├── agents/                       ← agent 定义（一个目录一个 agent）
│   ├── researcher/
│   │   └── handler.ts            ← config 块 + 可选 run 函数
│   └── writer/
│       └── handler.ts
└── tools/                        ← 所有 tool（agent 通过 config.tools 显式引用）
    ├── weather/handler.ts
    └── calculator/handler.ts
```

- **agent 位置**：`src/agents/<name>/handler.ts`，`<name>` 是目录名（如 `researcher`），可被 JSDoc `@agent` 覆盖
- **tool 位置**：`src/tools/<name>/handler.ts`（所有 tool 统一放 `src/tools/`，无 agent 专属 tool 概念）
- **tool 名**：`<目录名>.<函数名>`（如 `weather.getWeather`、`calculator.calc`）

## 写 agent handler

agent handler 导出 `config` 块（必需）和可选的 `run` 函数（自定义运行逻辑）。

### config 块字段

```ts
// src/agents/researcher/handler.ts
export const config = {
  /** 系统提示词，引导 LLM 作为某角色 */
  systemPrompt: '你是一个研究助手，可以查询天气和进行计算。',
  /** agent 显式声明可用的 tool 引用（必须在此显式声明，无全局共享 tool） */
  tools: ['weather.getWeather', 'calculator.calc'],
  /** 可调用的其他 agent 名（sub-agent 递归） */
  agents: ['writer'],
  /**
   * 默认 model 名（在 defaultLlm provider 的 models 里查找）
   * 不传时用 defaultLlm provider 的 models 第一个 key
   * 也可在运行时通过 agent.run(input, { model: '...' }) 切换
   */
  model: 'gpt-4o',
  /** 最大对话轮数（优先于全局 config.agent.maxTurns） */
  maxTurns: 5,
};
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `systemPrompt` | `string` | LLM 系统提示词 |
| `tools` | `string[]` | agent 显式声明可用的 tool 引用（必须显式声明，无全局共享 tool） |
| `agents` | `string[]` | 可调用的 sub-agent 名列表 |
| `model` | `string` | 默认 model 名（在 `defaultLlm` provider 的 `models` 里查找）；不传时用 `models` 第一个 key |
| `maxTurns` | `number` | 最大对话轮数，优先于全局 |

字段都通过 AST 字面量提取（`export const config = { ... }`），**不支持运行时表达式**（如 `systemPrompt: process.env.PROMPT` 会提取失败，字段为 `undefined`）。需要运行时拼装的提示词请在 `run` 函数中处理。

### JSDoc 描述（对 LLM 可见）

agent handler 的 JSDoc 自由文本会作为 agent 的 `description`，对 LLM 可见（用于父 agent 决策何时调用此 sub-agent）：

```ts
/**
 * Researcher agent — 负责研究主题，可调用 writer sub-agent 撰写内容
 *
 * @agent researcher  // 可选：覆盖目录推导的 agent 名
 */
export const config = { /* ... */ };
```

### 自定义 run 函数（可选）

默认 agent 走 `@faapi/agent` 的 ReAct 循环（LLM → tool → LLM）。导出 `run` 函数可完全替代 LLM 循环，适用于确定性子任务：

```ts
// src/agents/writer/handler.ts
export const config = {
  systemPrompt: '你是一个写作助手。',
};

/**
 * 自定义 run 函数
 *
 * sub-agent 调用时接收 args 对象，返回生成的内容。
 * 不走 LLM，直接返回结果（demo 简化，真实场景可调 LLM）。
 */
export async function run(args: { topic?: string }): Promise<string> {
  const topic = args.topic ?? '未知主题';
  return `关于「${topic}」的草稿：这是一份示例报告。`;
}
```

## 写 tool handler

tool handler 导出一个**具名函数**（函数名即 tool 名的后缀），第一个参数 interface 声明 input 类型（AST 提取生成 zod schema，LLM 调用时校验参数）。

```ts
// src/tools/weather/handler.ts

/** tool input 类型，AST 提取生成 zod.js，LLM 调用时校验 */
export interface WeatherInput {
  /** 城市名 */
  city: string;
}

/**
 * 查询城市天气
 *
 * JSDoc 描述作为 tool 的 description，对 LLM 可见。
 */
export async function getWeather(input: WeatherInput) {
  const temps: Record<string, number> = { 北京: 22, 上海: 25 };
  const temp = temps[input.city] ?? 20;
  return { city: input.city, temperature: temp, condition: '晴' };
}
```

- **函数名**：`getWeather` → tool 名为 `weather.getWeather`（`<目录名>.<函数名>`）
- **input 类型**：第一个参数的 interface 声明，AST 提取为 `WeatherInput` → 生成 `WeatherInputSchema`（`zod.js`）
- **JSDoc**：函数的 JSDoc 自由文本作为 tool description，参数 interface 字段的 JSDoc 作为参数描述
- **校验**：`@faapi/agent` 调 `loadToolSchema` 加载 `zod.js` → `z.toJSONSchema` 生成 JSON Schema 发给 LLM → LLM 返回参数后 `safeParse` 校验；失败返回 `{ error }`（不调 handler），回传 LLM 重试

tool 无 input 参数（无第一个 interface）或 `zod.js` 缺失时，用自由 schema `{ type: 'object' }`，LLM 自由传参，handler 内部自行处理参数合法性。

## handler 用 agent 参数

HTTP handler 的 `agent` 参数（内置注入，按参数名匹配）注入 `AgentHandle | undefined`：

```ts
// src/api/chat/handler.ts
import type { AgentHandle } from '@faapi/agent';

export interface ChatBody {
  input: string;
}

export async function POST(agent: AgentHandle | undefined, body: ChatBody) {
  if (!agent) {
    return new Response(JSON.stringify({ error: 'agent not available' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  const result = await agent.run(body.input);
  return {
    content: result.content,
    turns: result.turns,
    stopReason: result.stopReason,
  };
}
```

### AgentHandle 接口

| 方法 | 说明 |
|------|------|
| `agent.run(input, options?)` | 非流式执行，返回 `ReactLoopResult`（content / turns / stopReason / messages / usage / trace?） |
| `agent.stream(input, options?)` | 流式执行，yield `ReactLoopStreamChunk`（deltaContent / toolCall / toolResult / traceEvent? / done） |
| `agent.asTool()` | 包装为 `AgentToolDescriptor` 供父 agent 当 tool 调用（agent-as-tool 场景） |

`options` 支持临时覆盖本次调用的 LLM 配置（不修改 agent 自身状态，下一次调用仍用默认）：

```ts
interface AgentRunOptions {
  /** 覆盖本次调用的 agent 名（从 agentRegistry 查找对应元数据/tools/sub-agents）。
   *  不传时用 `config.agent.defaultAgent`；未设 defaultAgent 时必须显式传入，否则抛 AgentError */
  agent?: string;
  /** 切换 provider + model 的字符串 key（支持三种形式,见下文） */
  model?: string;
  /** 采样温度（透传给 LLM API,覆盖 provider/model 级 temperature） */
  temperature?: number;
  /** 最大生成 token 数（透传给 LLM API） */
  maxTokens?: number;
  /**
   * 启用 tracing（默认沿用全局 `config.agent.enableTracing`,全局默认 false——opt-in）。
   * 开启时返回值的 trace / traceEvent 字段填充结构化调用明细,详见「Tracing」章节。
   */
  enableTracing?: boolean;
}
```

**`options.agent` 按调用指定 agent**（v3.3.0）——多 agent 项目可不设 `defaultAgent`，按请求路由到不同 agent：

```ts
// src/api/chat/handler.ts
export function POST(agent: AgentHandle, body: { input: string; mode: string }) {
  // 不传 options.agent → 用 config.agent.defaultAgent（未设时抛 AgentError）
  // 按请求参数路由到不同 agent：tools/sub-agents/systemPrompt 都按指定 agent 解析
  const name = body.mode === 'write' ? 'writer' : 'researcher';
  return agent.run(body.input, { agent: name });
}
```

**`options.model` 字符串 key 解析规则**（三层）：

| 形式 | 示例 | 行为 |
|------|------|------|
| llms 的 key 精确匹配 | `'openai'` | 切到该 provider + 其 `models` 第一个 key |
| `provider/model` 一体化 | `'anthropic/claude-3-5-sonnet'` | 精确切到该 provider + 该 model（要求 model 在该 provider 的 `models` 里） |
| 纯 model 名 | `'gpt-4o'` | 在所有 provider 的 `models` 里查找；唯一时切到对应 provider；多个匹配时抛 `AgentError`（要求用 `provider/model` 消歧） |

不传 `options.model` 时用 `defaultLlm` provider + agent 元数据 `config.model`（都无时取 `models` 第一个 key）。

```ts
// 按请求切模型（纯 model 名,在 llms 里唯一时切到对应 provider）
await agent.run(input, { model: 'gpt-4o-mini' });

// provider/model 一体化形式（精确切换,跨 provider 场景推荐）
await agent.run(input, { model: 'anthropic/claude-3-5-sonnet' });

// provider key 精确匹配（切到该 provider,用其 models 第一个 key）
await agent.run(input, { model: 'anthropic' });
```

工厂未注册时（`@faapi/agent` 插件未加载或 `config.agent.llms` 未配置）注入 `undefined`，handler 需自行处理。`defaultAgent` 未设置时工厂正常注册，但 `agent.run(input)` 不传 `{ agent }` 会抛 `AgentError`。

## 多 agent 协作示例

### Researcher 调 tool + sub-agent

```ts
// src/agents/researcher/handler.ts
export const config = {
  systemPrompt: '你是一个研究助手，可以查询天气和进行计算，必要时调用 writer 撰写报告。',
  agents: ['writer'],                              // 可调用 writer sub-agent
  tools: ['weather.getWeather', 'calculator.calc'],
  model: 'gpt-4o',
  maxTurns: 5,
};
```

### Writer 作为 sub-agent（自定义 run）

```ts
// src/agents/writer/handler.ts
export const config = { systemPrompt: '你是一个写作助手。' };

export async function run(args: { topic?: string }): Promise<string> {
  return `关于「${args.topic ?? '未知主题'}」的草稿：...`;
}
```

### Chat handler 暴露 HTTP 接口

```ts
// src/api/chat/handler.ts
import type { AgentHandle } from '@faapi/agent';

export interface ChatBody { input: string; model?: string }

export async function POST(agent: AgentHandle | undefined, body: ChatBody) {
  if (!agent) return new Response('agent unavailable', { status: 503 });
  // 按请求切模型（body.model 是字符串 key,如 'gpt-4o-mini' 或 'anthropic/claude-3-5-sonnet'）
  const result = await agent.run(body.input, body.model ? { model: body.model } : undefined);
  return { content: result.content, turns: result.turns };
}
```

## agents 参数注入（所有 agent 元数据列表）

handler 的 `agents` 参数（内置注入）返回所有已注册**文件型 agent** 的 `AgentCore[]` 列表（**不合并 skillRegistry**——skill 与 agent 职责正交不耦合，skill 不参与 agent 查询链路），适用于 agent 管理界面、调试端点：

```ts
// src/api/agents/handler.ts
import type { AgentCore } from '@faapi/faapi';

export function GET(agents: AgentCore[]) {
  return agents.map(a => ({ name: a.name, description: a.description }));
}
```

## 运行时行为

### ReAct 循环

`agent.run(input)` 走 `@faapi/agent` 的 [reactLoop](../../../packages/agent/src/reactLoop.md)：

1. 组装 systemPrompt + tool 列表（agent `tools` + sub-agent 包装为 tool）
2. 调 LLM provider → LLM 返回 content 或 toolCalls
3. toolCalls → 执行 tool（`loadToolModule` + schema 校验）或递归 sub-agent（`maxAgentDepth` 防护）
4. tool 结果回灌 LLM → 循环直至 stopReason 或超出 maxTurns
5. 返回最终 content

### dev 按需编译

dev 模式下 agent handler.js / tool handler.js / zod.js 不在启动时预编译：

- **启动**：`scanAgents` / `scanTools` 仅读源码 + 正则提取，生成 `faapi-agents.js` + `faapi-tools.js` 清单
- **首次 agent 调用**：`loadAgentModule` / `loadToolModule` 先 `ensureCompiled` 单文件编译 → 再 import；`loadToolSchema` 按需生成 zod.js
- **watcher 文件变化**：清缓存，下次调用按需重建

prod 模式（`faapi build`）预编译全部产物，启动时直接读取。

### Tracing（结构化调用明细）

`agent.run()` / `agent.stream()` 默认关闭 tracing（`enableTracing` 默认 false——opt-in,可经 `config.agent.enableTracing: true` 全局开启或 `options.enableTracing` 单次开启）。开启时返回值附加结构化调用明细：

- **非流式**：`ReactLoopResult.trace?: AgentTrace`（agentName + startedAt + durationMs + turns + usage + stopReason + content + events）
- **流式**：`ReactLoopStreamChunk.traceEvent?: AgentTraceEvent`（与 deltaContent / toolCall / toolResult / done 互斥,增量推送）

**事件类型**（discriminated union,按 `type` 区分）：

| 事件 | 触发时机 | 含义 |
|------|---------|------|
| `llm_call` | 每轮调 `provider.complete()` / `provider.stream()` | 该轮 LLM 调用明细（model / inputMessages 快照 / response / stopReason / usage / timing） |
| `tool_call` | `executeTool` 返回 unknown（常规 tool） | tool 调用明细（name / arguments / result / error? / timing） |
| `subagent_call` | `executeTool` 返回 TracingToolResult（sub-agent 调用） | sub-agent 调用明细（agentName / input / trace 嵌套递归 / result / timing） |

**典型事件序列**（一次 2 轮 `agent.run()`,第 1 轮调常规 tool,第 2 轮调 sub-agent）：

```
llm_call(turn=1) → tool_call(turn=1) → llm_call(turn=2) → subagent_call(turn=2, 含 sub-trace)
```

**触发机制：opt-in（v3.3.0 起默认关闭）**

| 场景 | 配置 | 开销 |
|------|------|------|
| 生产主路径（默认） | 不配置 | 零——无新对象构造,enableTracing 缺省 false |
| 调试 / 开发面板 / tracing 端点 | `agent.run(input, { enableTracing: true })` 或 `config.agent.enableTracing: true` | 每轮 1 次 `performance.now()` 配对 + 每事件 ~100B 对象 + sub-agent 递归采集 |

**三层覆盖优先级**：`AgentRunOptions.enableTracing` > agent 自身配置 > `config.agent.enableTracing`（默认 false）。

**sub-agent 嵌套 trace**：父 agent 调 sub-agent 时,sub-agent 的 trace 自动嵌入父 trace 的 `subagent_call` 事件（递归结构,业务方可还原完整调用树）。仅默认 reactLoop 路径有 trace——sub-agent handler 导出 `run` 函数时走自定义逻辑,无 trace（业务方自己返回业务结果）。

#### 业务方使用示例

**调试单个 agent 调用**：

```ts
// src/api/chat/handler.ts
import type { AgentHandle } from '@faapi/agent';

export async function POST(agent: AgentHandle | undefined, body: { input: string }) {
  if (!agent) return new Response('agent unavailable', { status: 503 });
  const result = await agent.run(body.input, { enableTracing: true });
  console.log('agent trace:', JSON.stringify(result.trace, null, 2));
  return { content: result.content, turns: result.turns };
}
```

**生产路径不开启 tracing**（默认即零开销，无需任何配置）：

tracing 自 v3.3.0 起默认关闭——不配置 `enableTracing` 时 `result.trace` 为 `undefined`，零开销。仅在需要观测的端点单次开启（`agent.run(input, { enableTracing: true })`）或全局开启（`config.agent.enableTracing: true`）。

**流式前端展示**（SSE 推送 traceEvent）：

```ts
// src/api/chat/handler.ts
import type { AgentHandle } from '@faapi/agent';

export async function POST(agent: AgentHandle | undefined, ctx, body: { input: string }) {
  if (!agent) return new Response('agent unavailable', { status: 503 });
  const sse = ctx.sse();
  for await (const chunk of agent.stream(body.input, { enableTracing: true })) {
    if (chunk.deltaContent) sse.send({ event: 'delta', data: chunk.deltaContent });
    if (chunk.toolCall) sse.send({ event: 'tool_call', data: chunk.toolCall });
    if (chunk.toolResult) sse.send({ event: 'tool_result', data: chunk.toolResult });
    if (chunk.traceEvent) sse.send({ event: 'trace', data: chunk.traceEvent });
    if (chunk.done) sse.send({ event: 'done', data: chunk.done });
  }
  sse.close();
}
```

**生产 tracing 端点**（持久化到 DB / tracing 系统）：业务方在 `/api/agent-trace` 路由开 tracing,把 `result.trace` 持久化到 DB / Jaeger / OpenTelemetry。

> 类型导出自 `@faapi/agent`：`AgentTrace` / `AgentTraceEvent` / `LlmCallEvent` / `ToolCallEvent` / `SubAgentCallEvent` / `TracingToolResult` / `isTracingToolResult`。详见 [`@faapi/agent` 的 trace.md](../../../packages/agent/src/trace.md)。

## 常见坑点

### 1. config 块字段必须是字面量

```ts
// ❌ 运行时表达式，AST 提取失败
export const config = {
  systemPrompt: process.env.PROMPT,  // 字段为 undefined
  tools: getTools(),            // 字段为 undefined
};

// ✅ 字面量
export const config = {
  systemPrompt: '你是一个研究助手。',
  tools: ['weather.getWeather'],
};
```

运行时动态值请在 `run` 函数中处理。

### 2. tool 名格式

tool 名是 `<目录名>.<函数名>`，不是文件名。目录名 `weather` + 函数名 `getWeather` → `weather.getWeather`。引用时（agent 的 `tools` 字段）必须完全匹配。

### 3. agent 参数可能为 undefined

工厂未注册时 `agent` 参数注入 `undefined`（如 `@faapi/agent` 未安装、`config.agent.llms` 未配置）。handler 需处理此情况：

```ts
export async function POST(agent: AgentHandle | undefined, body: ChatBody) {
  if (!agent) return new Response('agent unavailable', { status: 503 });
  // ...
}
```

### 4. zod.js 缺失用自由 schema

tool 无 input 类型或 `zod.js` 加载失败时，`resolveToolSchema` 返回 `undefined`，agent 用 `{ type: 'object' }`，LLM 自由传参。handler 内部需自行校验参数合法性。

### 5. sub-agent 递归深度

`maxAgentDepth`（默认 3）限制 agent 调用 agent 的深度，超出抛 `AgentRecursionError`。根 agent depth=1，sub-agent 递增。

## DB-driven skills（运行时动态加载,与 agent 物理隔离）

agent 默认从 `src/agents/<name>/handler.ts` 编译期产物加载（文件型 agent）。但很多业务场景需要**运行时动态加载 skill**（admin 面板编辑、运营配置、A/B 测试）——skill 配置存在数据库 / 外部 API,不在文件系统里。

faapi 提供独立 [skillRegistry](https://github.com/faapi/faapi/blob/main/packages/faapi/src/injection/skillRegistry.ts) 让业务方在 plugin 里把 DB 数据转成 `AgentCore` 后动态注册。**skill 与 agent 物理隔离,职责正交不耦合**——agent 负责核心流程（含 `run` 函数的多步串联、文件型入口、sub-agent 递归），skill 用于拓展（运行时动态补充的 LLM 可见元数据，业务方 plugin 自行编排使用）。`agentRegistry.getAgent` 等查询函数**不 fallback 到 skillRegistry**——skill 不参与 agent 查询链路、不覆盖文件型 agent、不参与 sub-agent 递归。

### 接入步骤

**1. 写一个本地 plugin 桥接 DB → skillRegistry**

```ts
// plugins/db-skills.ts(业务方自定义插件)
import { MongoClient } from 'mongodb';
import {
  hydrateSkillRegistry,
  upsertSkill,
  removeSkill,
  getSkill,
  listSkills,
  type AgentCore,
} from '@faapi/faapi';
import type { FaapiPlugin } from '@faapi/faapi';

interface DbSkill {
  name: string;
  description?: string;
  systemPrompt?: string;
  tools?: string[];
  agents?: string[];
  model?: string;
  maxTurns?: number;
}

// DB 记录转 AgentCore（DB skill 只实现 LLM 可见字段,无代码加载细节）
function skillToCore(s: DbSkill): AgentCore {
  return {
    name: s.name,
    description: s.description,
    systemPrompt: s.systemPrompt,
    tools: s.tools,
    agents: s.agents,
    model: s.model,
    maxTurns: s.maxTurns,
  };
}

export default {
  setup({ config }) {
    const client = new MongoClient(process.env.MONGODB_URI!);

    // onReady 启动时全量加载
    config.lifecycle = config.lifecycle ?? {};
    const prevOnReady = config.lifecycle.onReady;
    config.lifecycle.onReady = async (ctx) => {
      await client.connect();
      await prevOnReady?.(ctx);

      const skills = await client
        .db('faapi')
        .collection<DbSkill>('skills')
        .find()
        .toArray();
      hydrateSkillRegistry(skills.map(skillToCore));

      // 监听 DB 变更增量更新(热更新)
      client
        .db('faapi')
        .collection<DbSkill>('skills')
        .watch()
        .on('change', (change) => {
          if (
            change.operationType === 'insert' ||
            change.operationType === 'update'
          ) {
            upsertSkill(skillToCore(change.fullDocument!));
          } else if (change.operationType === 'delete') {
            removeSkill(change.documentKey.name as string);
          }
        });
    };
  },
} satisfies FaapiPlugin;
```

**2. 在 `faapi.config.ts` 声明**

```ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  agent: {
    llms: {
      openai: { provider: 'openai', apiKey: '...', models: { 'gpt-4o': {} } },
    },
    defaultLlm: 'openai',
    defaultAgent: 'researcher',
    // 无全局共享 tool,tool 引用列表只在每个 agent 的 tools 里显式声明
  },
  plugins: [
    '@faapi/agent',
    './plugins/db-skills',  // 业务方本地 plugin
  ],
} satisfies FaapiConfig;
```

**3. DB 里存 skill 记录**

```js
// MongoDB skills 集合示例
{
  name: 'translator',
  description: '翻译助手',
  systemPrompt: '你是一个翻译助手,根据用户输入语言自动翻译',
  tools: ['translate.detect', 'translate.convert'],  // 引用文件型 tool
  agents: [],                                          // 业务方自行编排使用,框架核心不消费
  model: 'gpt-4o',
  maxTurns: 5,
}
```

**4. handler 通过自定义注入器或中间件访问 skill**

skill 不再通过 `agents` 参数注入、不再被 `@faapi/agent` 子包的 Agent 类自动消费。业务方需要让 handler 看到 skill 时,自行通过注入器或中间件机制注入：

```ts
// src/middlewares.ts
import { getSkill, type AgentCore } from '@faapi/faapi';
import type { FaapiMiddleware, InjectorMap } from '@faapi/faapi';

const skillInjector: FaapiMiddleware = async (ctx, next) => {
  // 业务方自行决定把哪个 skill 塞到 ctx(如按 query.skillName 查找)
  const skillName = ctx.query.skillName as string | undefined;
  if (skillName) {
    ctx.skill = getSkill(skillName);
  }
  await next();
};

export default [skillInjector] satisfies FaapiMiddleware[];

export const injectors: InjectorMap = {
  // 注入器按参数名匹配 handler 参数
  skill: (ctx) => ctx.skill,
};
```

```ts
// src/api/skill-runner/handler.ts
import type { AgentCore } from '@faapi/faapi';

export interface Query { skillName: string }
export interface Body { input: string }

export function POST(skill: AgentCore | undefined, body: Body) {
  if (!skill) return new Response('skill not found', { status: 404 });
  // 业务方自行编排 skill——此处只展示拿到的 AgentCore 字段
  return {
    name: skill.name,
    systemPrompt: skill.systemPrompt,
    // 业务方自行决定如何执行（如调自定义 LLM 客户端、组装 messages 等）
  };
}
```

### DB skill 字段约定

DB skill 只实现 `AgentCore` 接口（LLM 可见字段），无需 `filePath` / `hasRun` 等代码加载细节（这些属于 `AgentMetadata`，仅文件型 agent 实现）。

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | skill 名（唯一标识） |
| `description` | 可选 | skill 描述（业务方自行决定如何使用，如展示在 UI、组装到 LLM 请求） |
| `systemPrompt` | 可选 | LLM 系统提示词 |
| `tools` | 可选 | tool 引用列表（业务方自行解析使用,框架核心不消费） |
| `agents` | 可选 | sub-agent 引用列表（业务方自行编排使用,**不再被 agent 的 `agents` 列表自动引用**） |
| `model` | 可选 | 默认 model 名（业务方自行解析） |
| `maxTurns` | 可选 | 最大对话轮数（业务方自行解析） |

### 双 registry 设计

| 来源 | registry | 注入时机 | reload 影响 | 查询链路 |
|------|-----------|----------|-------------|---------|
| 文件型 agent（`src/agents/<name>/handler.ts`） | `agentRegistry` | `createAppBase` 启动期 | dev watcher 重新 hydrate | 供 agent 注入器 / `@faapi/agent` 子包自动消费 |
| DB skill（plugin 动态注册） | `skillRegistry` | 业务方 `onReady` + 运行时增量 | 不受影响 | 仅供业务方 plugin 内部主动调用 |

**职责正交不耦合**：agentRegistry 的查询函数（`getAgent` / `listAgents` / `resolveAgentTools` / `resolveSubAgents` / `asTool`）**不 fallback 到 skillRegistry**。skill 不覆盖文件型 agent、不参与 sub-agent 递归——两者是补充关系而非覆盖关系。

### 限制

- DB skill 不支持自定义 `run` 函数（多步 prompt 串联）——需要 `run` 函数的场景仍走文件型 agent
- DB skill 不被 `@faapi/agent` 子包的 Agent 类自动消费、不参与 sub-agent 递归——业务方需自行编排使用
- DB skill 引用的 `tools` / `agents` 字段由业务方自行解析使用,框架核心不消费
- DB skill 的 `model` 字段由业务方自行解析使用,框架核心不消费

## 检查清单

- [ ] `pnpm add @faapi/agent` 已安装
- [ ] `faapi.config.ts` 声明 `agent.llms` + `agent.defaultLlm`（可选）+ `agent.defaultAgent` + `plugins: ['@faapi/agent']`
- [ ] 每个 `llms.<provider>` 含 `provider` / `apiKey` / `models` 字段（`models` 必填,空对象 `{}` 表示用 provider 级默认）
- [ ] `src/agents/<name>/handler.ts` 导出 `config` 块（字面量字段）
- [ ] `src/tools/<name>/handler.ts` 导出具名函数 + 第一个参数 interface
- [ ] handler 的 `agent` 参数类型为 `AgentHandle | undefined`，处理 undefined 情况
- [ ] 跨 provider 切模型用 `agent.run(input, { model: 'anthropic/claude-3-5-sonnet' })` 一体化形式
- [ ] `llms.<provider>.apiKey` 通过 `process.env.OPENAI_API_KEY` 读取（配合 `.env`）
- [ ] tracing 默认关闭（v3.3.0 起 opt-in）——需要观测的端点显式 `agent.run(input, { enableTracing: true })` 或 `config.agent.enableTracing: true` 开启;不开启时 `result.trace` 为 `undefined`,零开销
- [ ] 调试 / 开发面板 / tracing 端点用 `result.trace` 或流式 `chunk.traceEvent`（`@faapi/agent` 导出 `AgentTrace` / `AgentTraceEvent` 等类型）
- [ ] sub-agent handler 导出 `run` 函数时无 trace——需 trace 时让 sub-agent 走默认 reactLoop（不导出 `run`）
- [ ] `pnpm typecheck` 通过
- [ ] `faapi dev` 启动后首次 agent 调用能触发按需编译
- [ ] 若用 DB-driven skill:plugin 在 `lifecycle.onReady` 调 `hydrateSkillRegistry` 全量灌入 + 监听 DB change stream 调 `upsertSkill` / `removeSkill` 增量更新;DB skill 实现的是 `AgentCore`（不含 `filePath` / `hasRun`）;skill 与 agent 物理隔离——不被 `agents` 参数注入、不被 `@faapi/agent` 子包自动消费、不参与 sub-agent 递归,业务方需自行通过注入器或中间件机制注入 skill 给 handler
