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
    llm: {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      model: 'gpt-4o',
      // baseURL: 'https://api.openai.com/v1',  // 可选，OpenAI 兼容 API
      // temperature: 0.7,                     // 透传给 LLM API
    },
    defaultAgent: 'researcher',
    maxTurns: 10,
    maxAgentDepth: 3,
    defaultTools: ['weather.getWeather'],
  },
  plugins: ['@faapi/agent'],
} satisfies FaapiConfig;
```

| 字段 | 说明 | 缺失行为 |
|------|------|---------|
| `llm` | LLM 提供方配置（provider/apiKey/model/baseURL） | 不注册工厂，`agent` 参数注入 `undefined` |
| `defaultAgent` | 默认 agent 名（`agent` 参数注入读取） | 不注册工厂，`agent` 参数注入 `undefined` |
| `maxTurns` | 默认最大对话轮数 | agent 自身 `config.maxTurns` 优先，都无时用框架默认 |
| `maxAgentDepth` | agent 调用 agent 的最大递归深度（默认 3） | 用框架默认 3 |
| `defaultTools` | 所有 agent 共享的 tool 列表 | 不追加共享 tool |

`llm.apiKey` / `llm.model` 等通过 `process.env.XXX` 读取，配合 `.env` 文件管理敏感值，详见 [multi-env.md](./multi-env.md)。

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
  /** agent 显式声明可用的 tool 引用（与全局 defaultTools 合并） */
  tools: ['weather.getWeather', 'calculator.calc'],
  /** 可调用的其他 agent 名（sub-agent 递归） */
  agents: ['writer'],
  /** LLM 模型名（优先于全局 config.agent.llm.model） */
  model: 'gpt-4o',
  /** 最大对话轮数（优先于全局 config.agent.maxTurns） */
  maxTurns: 5,
};
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `systemPrompt` | `string` | LLM 系统提示词 |
| `tools` | `string[]` | agent 显式声明可用的 tool 引用，与全局 `defaultTools` 合并 |
| `agents` | `string[]` | 可调用的 sub-agent 名列表 |
| `model` | `string` | LLM 模型名，优先于全局 |
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
| `agent.run(input)` | 非流式执行，返回 `ReactLoopResult`（content / turns / stopReason / messages / usage） |
| `agent.stream(input)` | 流式执行，yield `ReactLoopStreamChunk`（deltaContent / toolCall / toolResult / done） |
| `agent.asTool()` | 包装为 `AgentToolDescriptor` 供父 agent 当 tool 调用（agent-as-tool 场景） |

工厂未注册时（`@faapi/agent` 插件未加载或 `config.agent.llm` / `defaultAgent` 未配置）注入 `undefined`，handler 需自行处理。

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

export interface ChatBody { input: string }

export async function POST(agent: AgentHandle | undefined, body: ChatBody) {
  if (!agent) return new Response('agent unavailable', { status: 503 });
  const result = await agent.run(body.input);
  return { content: result.content, turns: result.turns };
}
```

## agents 参数注入（所有 agent 元数据列表）

handler 的 `agents` 参数（内置注入）返回所有已注册 agent 的元数据列表（`AgentMetadata[]`），适用于 agent 管理界面、调试端点：

```ts
// src/api/agents/handler.ts
export function GET(agents: AgentMetadata[]) {
  return agents.map(a => ({ name: a.name, description: a.description }));
}
```

## 运行时行为

### ReAct 循环

`agent.run(input)` 走 `@faapi/agent` 的 [reactLoop](../../../packages/agent/src/reactLoop.md)：

1. 组装 systemPrompt + tool 列表（`tools` + `defaultTools` + sub-agent 包装为 tool）
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

tool 名是 `<目录名>.<函数名>`，不是文件名。目录名 `weather` + 函数名 `getWeather` → `weather.getWeather`。引用时（`tools` / `defaultTools`）必须完全匹配。

### 3. agent 参数可能为 undefined

工厂未注册时 `agent` 参数注入 `undefined`（如 `@faapi/agent` 未安装、`config.agent.llm` 未配置）。handler 需处理此情况：

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

## 检查清单

- [ ] `pnpm add @faapi/agent` 已安装
- [ ] `faapi.config.ts` 声明 `agent.llm` + `agent.defaultAgent` + `plugins: ['@faapi/agent']`
- [ ] `src/agents/<name>/handler.ts` 导出 `config` 块（字面量字段）
- [ ] `src/tools/<name>/handler.ts` 导出具名函数 + 第一个参数 interface
- [ ] handler 的 `agent` 参数类型为 `AgentHandle | undefined`，处理 undefined 情况
- [ ] `llm.apiKey` 通过 `process.env.OPENAI_API_KEY` 读取（配合 `.env`）
- [ ] `pnpm typecheck` 通过
- [ ] `faapi dev` 启动后首次 agent 调用能触发按需编译
