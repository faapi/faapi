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
- **按请求切 provider/model**：`agent.run(input, { model })` 通过字符串 key 切换
  provider + model,适用于「按用户身份 / tier 选模型」「A/B 测试不同 provider」等运行时动态切换场景。
  不修改 agent 自身状态,下一次调用仍用默认配置。
- **外部 provider（BYOK / 自定义网关）**：`agent.run(input, { provider })` 传入
  `LlmConfig` 配置对象（用户自带 apiKey / 自定义 baseURL）或 `LLMProvider` 实例
  （自研模型网关等框架未内置适配器的 LLM 服务）,本次调用直接使用——完全不走
  `config.agent.llms`。详见下方「`options.provider` 外部 provider」章节。
- **中断恢复 / 多轮对话**：`agent.run(undefined, { messages })` 从断点续跑
  （`AgentAbortError.messages` / `ReactLoopError.messages`）,或 `agent.run(新输入, { messages })`
  把上次历史 + 新输入拼接为多轮对话。详见 [reactLoop.md](./reactLoop.md) 中断恢复章节。

```ts
// src/api/chat/handler.ts
import type { AgentHandle } from '@faapi/agent';

export async function POST(agent: AgentHandle, body: { input: string; tier?: 'fast' | 'smart' }) {
  const result = await agent.run(body.input, {
    // model 字符串 key：纯 model 名（在 llms 里唯一时切到对应 provider）
    model: body.tier === 'smart' ? 'gpt-4o' : 'gpt-4o-mini',
  });
  return { content: result.content };
}

// provider/model 一体化形式（精确切换）
export async function POST(agent: AgentHandle, body: { input: string }) {
  const result = await agent.run(body.input, {
    model: 'anthropic/claude-3-5-sonnet',  // 精确切到 anthropic provider + 该 model
  });
  return { content: result.content };
}

// 外部 provider 形式一：LlmConfig 配置对象（用户自带 key,BYOK）
export async function POST(agent: AgentHandle, body: { input: string; apiKey: string; model: string }) {
  const result = await agent.run(body.input, {
    provider: { provider: 'openai', apiKey: body.apiKey },  // 现场创建适配器,不查 llms
    model: body.model,  // 原始 model 名,原样透传（支持带 / 的 id,如 OpenRouter）
  });
  return { content: result.content };
}

// 外部 provider 形式二：LLMProvider 实例（自定义内部模型网关）
import type { LLMProvider } from '@faapi/agent';
export async function POST(agent: AgentHandle, body: { input: string }, gateway: LLMProvider) {
  const result = await agent.run(body.input, { provider: gateway, model: 'internal-model' });
  return { content: result.content };
}
```

## 设计

### 接口定义

```ts
interface AgentRunOptions {
  signal?: AbortSignal;  // 取消信号：abort 后当前轮请求中断并抛 AgentAbortError,不再进入下一轮
  /**
   * 切换 provider + model 的字符串 key,支持三种形式：
   * - llms 的 key 精确匹配（如 'openai'）→ 用该 provider + 其 models 的第一个 model
   * - `provider/model` 一体化（如 'openai/gpt-4o'）→ 在 llms 里按 provider+model 精确匹配
   * - 纯 model 名（如 'gpt-4o'）→ 在所有 provider 的 models 里按 model 名查找,
   *   唯一时切到对应 provider；多个时报错（要求用 `provider/model` 消歧）；无匹配时报错
   * 不传时用 `defaultLlm` provider + agent 元数据 `config.model`
   */
  model?: string;
  /**
   * 外部 provider（本次调用临时使用,优先级最高——完全不查 config.agent.llms）
   *
   * 两种形式：
   * - `LlmConfig` 对象（含 `provider` / `apiKey` / `baseURL` 等字段）→ 现场调
   *   `createProvider` 创建适配器（浅拷贝,不改调用方对象）,适用于 BYOK / 按请求指定网关
   * - `LLMProvider` 实例（实现 `complete` / `stream`）→ 直接使用,适用于框架未内置
   *   适配器的 LLM 服务（内部自研模型网关等）
   *
   * 传入时 `options.model` 语义变为「原始 model 名」——不做 llms key 解析,原样透传给该
   * provider（支持带 / 的 model id,如 OpenRouter 的 'anthropic/claude-3.5-sonnet'）。
   * LlmConfig 形式下 `options.model` 缺省时回落该 config 的 `models` 第一个 key,
   * 两者皆无抛 `AgentError`；LLMProvider 实例形式下可为 `undefined`（自定义 provider 自决）。
   *
   * 仅影响本次调用——sub-agent 递归不继承外部 provider（sub-agent 仍走默认解析）,
   * agent 状态不变,下一次调用仍用默认配置。每次调用现场物化 provider,不进 providers Map。
   */
  provider?: LlmConfig | LLMProvider;
  /** 采样温度（透传给 LLM API,覆盖 provider/model 级 temperature） */
  temperature?: number;
  /** 最大生成 token 数（透传给 LLM API） */
  maxTokens?: number;
  /**
   * 初始对话历史（续跑 / 多轮对话,语义详见 [reactLoop.md](./reactLoop.md) 中断恢复章节）
   *
   * 提供时以其为基础（历史应含 system）,agent 的 systemPrompt 缺失时自动补齐；
   * `input` 非空时追加为新的 user 消息（多轮对话）,为空时纯续跑。
   * 续跑源:`AgentAbortError.messages`（中断断点）/ `ReactLoopError.messages`（maxTurns 超限）/
   * 上次 `result.messages`（多轮对话）。历史经结构校验,assistant.toolCalls 与 tool 结果
   * 配对不完整时抛 `AgentError`。
   */
  messages?: LLMMessage[];
}

interface AgentHandle {
  run(input?: string, options?: AgentRunOptions): Promise<ReactLoopResult>;
  stream(input?: string, options?: AgentRunOptions): AsyncIterable<ReactLoopStreamChunk>;
  asTool(): AgentToolDescriptor | undefined;
}
```

`options` 全可选——不传时用 `defaultLlm` provider + agent 元数据 `config.model`。
`input` 变为可选（续跑场景不传新输入）——`input` 与 `options.messages` 都为空时抛 `AgentError`。
传 `options.model` 时按字符串 key 解析规则定位 provider + model,临时覆盖本次调用,
**不修改 agent 自身状态**,下一次 `run` 仍用默认配置。

### Run-level 覆盖优先级

`buildLoopConfig` 组装 `ReactLoopConfig` 时各字段优先级（高 → 低）：

| 字段 | 优先级 1（最高） | 优先级 2 | 优先级 3（默认） |
| --- | --- | --- | --- |
| `agentName` | `options.agent` | — | `deps.agentName`（`config.agent.defaultAgent`） |
| `provider` | `options.provider` 物化的外部 provider（跳过全部 llms 解析） | `options.model` 解析出的 provider（key 含 provider 时） | `deps.defaultProvider`（`defaultLlm` 对应的 provider 实例） |
| `model` | `options.model`（外部 provider 时为原始 model 名,原样透传） | `options.model` 解析出的 model / `meta.model`（agent 元数据） | `defaultLlm` provider 的 models 第一个 key |
| `temperature` | `options.temperature` | model 级 `models[m].temperature` | provider 级 `LlmConfig.temperature` |
| `maxTokens` | `options.maxTokens` | — | `LlmConfig.maxTokens`（全局透传） |
| `maxTurns` | — | `meta.maxTurns`（agent 元数据） | `AgentRuntimeConfig.maxTurns`（全局） |

> `provider` / `temperature` / `maxTokens` 没有「agent 元数据」层——agent handler 的 `config` 块只提取 `systemPrompt` / `model` / `maxTurns` / `tools` / `agents`,不提取 provider/temperature/maxTokens。

### `options.model` 字符串 key 解析规则

`buildLoopConfig` 收到 `options.model` 后按以下顺序解析（命中即停）：

0. **外部 provider 接管**：`options.provider` 存在时**跳过下方全部 key 解析**——
   `options.model` 不再是 llms key,而是原始 model 名原样透传给外部 provider
   （详见下方「`options.provider` 外部 provider」章节）
1. **llms key 精确匹配**：`options.model` 等于 `config.agent.llms` 的某个 key（如 `'openai'`）
   → 用该 key 对应的 provider 实例 + 该 provider `models` 的第一个 key 作为 model
2. **`provider/model` 一体化**：`options.model` 含 `/`,拆成 `[provider, model]`
   → 在 `llms` 里找 `key === provider` 的项 → 用该 provider 实例 + 该 model（要求该 model 在其 `models` 里）
3. **纯 model 名模糊匹配**：`options.model` 不含 `/` 且非 llms key
   → 遍历所有 `llms` 的 `models`,找 `models[options.model]` 存在的项：
   - 唯一匹配 → 用该 provider 实例 + 该 model
   - 多个匹配 → 抛 `AgentError`（要求用 `provider/model` 消歧）
   - 无匹配 → 抛 `AgentError`（model 不在任何 provider 下,要求在 `llms.*.models` 里声明）

不传 `options.model` → 用 `defaultLlm` provider + agent 元数据 `config.model`（或该 provider 的 models 第一个）。

### `options.provider` 外部 provider

`options.provider` 允许调用时临时传入 `config.agent.llms` 之外的外部 provider,两种形式：

| 形式 | 物化方式 | model 解析 |
| --- | --- | --- |
| `LlmConfig` 对象（含字符串 `provider` 字段） | 现场调 `createProvider`（浅拷贝 + `models` 兜底 `{}`,不改调用方对象） | `options.model` 原样透传；缺省回落该 config `models` 第一个 key；两者皆无抛 `AgentError` |
| `LLMProvider` 实例（有 `complete` / `stream` 方法） | 直接使用 | `options.model` 原样透传,可为 `undefined`（自定义 provider 自决） |

两者皆非（如普通对象缺 `provider` 字段）→ 抛 `AgentError`。

关键语义：

- **`options.model` 变为原始 model 名**——不做 llms key 解析、不拆 `/`。带斜杠的 model id
  （如 OpenRouter 的 `'anthropic/claude-3.5-sonnet'`）原样发给外部 provider
- **优先级最高**——同时传 `options.provider` + `options.model`（llms 里已声明的 key）时,
  走外部 provider 且 model 原样透传,llms 声明被完全忽略
- **调用级作用域**——外部 provider 仅本次 `run` / `stream` 生效：不进 `providers Map`、
  不修改 agent 状态；**sub-agent 递归不继承**（sub-agent 仍走默认解析链路）
- **透传字段生效**——`LlmConfig` 形式的 provider 级透传字段（`temperature` / `top_p` 等）
  与 `timeoutMs` / `maxRetries` 与内置 provider 行为完全一致（同一 `createProvider` 路径）；
  `options.temperature` / `options.maxTokens` 仍为 request 级最高优先级

典型场景：

- **BYOK**：SaaS 终端用户自带 API key,服务端不托管凭证
- **按请求指定网关**：同一服务按租户 / 区域路由到不同 baseURL
- **自定义 LLM 服务**：内部自研模型网关实现 `LLMProvider` 接口后直接注入,
  无需框架内置适配器

### Agent 满足 AgentHandle（结构化类型）

[Agent](./agent.md) 类的方法签名与 `AgentHandle` 完全匹配：

| AgentHandle 方法 | Agent 实现 | 说明 |
| --- | --- | --- |
| `run(input, options?)` | `async run(input: string, options?: AgentRunOptions): Promise<ReactLoopResult>` | 组装 config（应用 options 覆盖）→ 调 reactLoop |
| `stream(input, options?)` | `async *stream(input: string, options?: AgentRunOptions): AsyncIterable<ReactLoopStreamChunk>` | 组装 config（应用 options 覆盖）→ 调 reactLoopStream |
| `asTool()` | `asTool(): AgentToolDescriptor \| undefined` | 包装为 tool 描述符 |

因此 plugin 的工厂直接 `return new Agent(deps)`,TS 结构化类型自动判定满足 `AgentHandle`。

### 注入流程

```
faapi.config.ts 配置 agent.llms + agent.defaultLlm + agent.defaultAgent（可选）
         ↓
@faapi/agent plugin setup()
  ├─ 读 config.agent.llms → 遍历每个 LlmConfig 调 createProvider → Map<providerKey, LLMProvider>
  ├─ 读 config.agent.defaultLlm → defaultProvider = providers.get(defaultLlm)
  ├─ 读 config.agent.defaultAgent（可选）/ maxTurns / maxAgentDepth
  ├─ 从 @faapi/faapi import 注册表/加载器访问器（getAgent / getTool / resolveAgentTools / resolveSubAgents / loadAgentModule / loadToolModule)
  └─ registerAgentHandleFactory((ctx) => {
       return new Agent({ providers, defaultProvider, agentName: defaultAgent, rootDir, config, getAgent, ... });
     })
         ↓
handler GET(agent: AgentHandle)
  └─ injectParams case 'agent' → getAgentHandle(ctx) → 工厂返回 Agent 实例
         ↓
agent.run(input) / agent.run(input, { agent: 'researcher' }) / agent.stream(input, { model: 'gpt-4o' })
```

### 工厂未注册时的行为

工厂未注册（`@faapi/agent` 插件未加载或 `config.agent.llms` 未配置）时,`getAgentHandle(ctx)` 返回 `undefined`,handler 的 `agent` 参数为 `undefined`。handler 需自行处理此情况（如返回 503 错误）。

`defaultAgent` 未设置但工厂已注册时,`agent` 参数正常注入 Agent 实例,但 `agent.run(input)` 不传 `{ agent: 'name' }` 时抛 `AgentError`（agent 名为空字符串,查注册表返回 `undefined`）。

## 相关模块

- [agent](./agent.md) —— Agent 类,满足 AgentHandle 接口
- [plugin](./plugin.md) —— @faapi/agent faapi 插件,注册工厂函数
- [reactLoop](./reactLoop.md) —— run / stream 委托给的循环引擎
- faapi 核心 [agentHandle 工厂](../../faapi/src/injection/agentHandle.md) —— 工厂注册/查询/清理机制
- faapi 核心 [injectParams](../../faapi/src/injection/injectParams.md) —— `agent` 参数注入点
