# provider

一句话概括：LLM Provider 抽象层——统一 `complete` / `stream` 接口，messages / tools / message / usage 采用 **OpenAI chat completions 形状作为规范形**，屏蔽 OpenAI / Anthropic 等 LLM 服务差异，让 reactLoop 与 Agent 类对 LLM 无关。

## 为什么需要

[reactLoop](./reactLoop.md)（Phase 3.3）与 [Agent 类](./agent.md)（Phase 3.4）需要把 messages + tools 发给 LLM，并拿回 assistant 消息（含可能的 `tool_calls`）。但 LLM 服务有差异：

- OpenAI / Azure OpenAI / 本地 LiteLLM / 阿里通义 / 智谱 → OpenAI 兼容 API
- Anthropic Claude → Messages API（与 OpenAI 不同）
- Google Gemini → generateContent API

直接在 reactLoop 里 `fetch` OpenAI 会让 LLM 服务耦合死，且未来加 provider 要改 reactLoop。`LLMProvider` 接口把"如何调用 LLM"封装在 provider 适配器里，reactLoop 只看抽象接口。

## 规范形 = OpenAI chat completions 形状

messages / tools / assistant message / usage 的规范形**直接采用 OpenAI chat completions 的线格式**（`tool_calls` / `tool_call_id` / `function.parameters` / `prompt_tokens`），不自创拼写。理由：

1. **OpenAI 形状是生态事实标准**——主流 provider / 网关 / vLLM 均提供 OpenAI 兼容端点，Anthropic 亦有兼容层，消费方零学习成本
2. **OpenAI provider 退化为恒等变换**——请求 messages / tools 原样透传，无重拼写；Anthropic 等非 OpenAI provider 在各自适配器内做"OpenAI → 该家"翻译，不引入第三种形状
3. **观测 / 存储 / 展示 / 提取等消费方只需懂一种格式**——recording provider、call log 分析、回放展示直接按 OpenAI 形状处理，无需框架格式兼容层

边界（保持内部抽象，不采用线格式）：

- `LLMStreamChunk` —— provider 的流事件抽象（增量 token 已聚合、tool_calls 累积完成后整体 emit），不是 OpenAI 的分片 delta 线格式
- `LLMStopReason` —— 词表恰与 OpenAI `finish_reason` 一致（`stop` / `tool_calls` / `length` / `content_filter` / `other`），收窄未知值为 `other`
- `ReactLoopStreamChunk` / trace 事件 —— reactLoop 层事件（tool 参数已 JSON.parse 为对象），非线格式

## 使用场景

- [reactLoop](./reactLoop.md) 每轮调 `provider.complete()` 或 `provider.stream()` 发送 messages + tools，拿回 assistant 消息
- [Agent 类](./agent.md) 构造时接收 `LLMProvider` 实例（由 [createProvider](#createprovider) 工厂创建），传给 reactLoop
- 业务方自定义 provider：实现 `LLMProvider` 接口即可对接任意 LLM 服务（如内部自研模型网关）；
  可在 `agent.run(input, { provider })` 调用时直接注入实例或 `LlmConfig` 配置对象（外部 provider,
  不查 `config.agent.llms`），也可经 [plugin](./plugin.md) 从 `config.agent.llms` 批量创建

## 设计

### 核心类型

| 类型 | 说明 |
| --- | --- |
| `LLMMessage` | 对话消息，OpenAI chat completions 形状（role + content + 可选 `tool_calls` / `tool_call_id`） |
| `LLMToolCall` | assistant 消息内的 tool 调用，OpenAI 形状（`id` + `type: 'function'` + `function: { name, arguments }`，`arguments` 为 JSON 字符串） |
| `LLMToolDefinition` | tool 定义，OpenAI 形状（`type: 'function'` + `function: { name, description?, parameters? }`） |
| `LLMCompleteRequest` | complete / stream 的入参（messages + tools + 可选 model / temperature / maxTokens） |
| `LLMResponse` | complete 的返回（message + stopReason + usage） |
| `LLMStreamChunk` | stream 的单个 chunk（deltaContent + deltaReasoning + toolCalls + finishReason + usage，provider 内部流抽象） |
| `LLMUsage` | token 用量，OpenAI 形状（`prompt_tokens` + `completion_tokens` + `total_tokens`） |

```ts
interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;          // role='tool' 时
  tool_calls?: LLMToolCall[];     // role='assistant' 时
  reasoning_content?: string;     // role='assistant' 时（thinking 模型）——解析产物，不回传 API
}

interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;            // JSON 字符串（线格式原样，执行前由 reactLoop JSON.parse）
  };
}

interface LLMToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;  // JSON Schema
  };
}

interface LLMUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
```

`tool_calls[].function.arguments` 保持线格式的 JSON **字符串**（不预解析）——消息历史可原样透传给 LLM 与原样持久化，解析边界收敛在 reactLoop（执行 / 鉴权钩子 / trace 拿到的都是已 parse 的对象）。

### thinking（推理内容）

thinking 模型（DeepSeek-R1 / Qwen-thinking / OpenAI o 系列等）在 `content` 之外返回推理内容。规范形的处理策略：

| 方向 | 字段 | 说明 |
| --- | --- | --- |
| 响应侧（解析） | `LLMMessage.reasoning_content` | 非流式：assistant 消息携带完整推理内容（DeepSeek 线格式字段名） |
| 响应侧（解析） | `LLMStreamChunk.deltaReasoning` | 流式：推理内容增量 chunk，与 `deltaContent` 互斥出现 |
| 请求侧（剥离） | —— | 发送给 LLM 时剥离 `reasoning_content`——DeepSeek 明确要求多轮对话不回传（回传 400），OpenAI 等拒绝未知字段 |

解析兼容两种线格式：优先 `reasoning_content`（DeepSeek / Qwen 事实标准），缺失时读 `reasoning`（OpenRouter 形状），统一映射到 `reasoning_content` / `deltaReasoning`。消费方（SSE 转发、UI"思考中"展示、审计日志）只认规范形字段。

`reasoning_content` 是**解析产物**而非对话内容——进入 `LLMMessage` 仅为让 complete 的返回自包含，provider 发送请求、reactLoop 组装历史时均剥离（剥离责任分层见 [reactLoop.md](./reactLoop.md) 的 thinking 章节）。

### `LLMProvider` 接口

```ts
interface LLMProvider {
  complete(request: LLMCompleteRequest): Promise<LLMResponse>;
  stream(request: LLMCompleteRequest): AsyncIterable<LLMStreamChunk>;
}
```

- `complete` —— 非流式，阻塞到 LLM 返回完整响应。适合批处理 / 工具调用循环（不需要流式 token）
- `stream` —— 流式，异步迭代 chunk。reactLoop 流式模式用它，逐 token 推给 SSE 客户端；累积 tool_calls 完成后执行 tool

### `createProvider` 工厂

```ts
function createProvider(config: LlmConfig): LLMProvider;
```

按 `config.provider` 字段路由到对应适配器：

| `provider` 值 | 适配器 | 说明 |
| --- | --- | --- |
| `'openai'` | [createOpenAIProvider](./providers/openai.md) | OpenAI 兼容 API（含 Azure / 中转 / LiteLLM） |
| 其他 | 抛 `Error` | Phase 3.2 仅支持 `'openai'`，不静默降级（参考 AGENTS.md §6.3） |

### 错误处理

- 不支持的 `provider` → 抛 `Error("Unsupported LLM provider: <name>")`，不返回 stub
- HTTP / 网络错误由具体 provider 抛 `LLMProviderError`（含 status + body 摘要）
- JSON / SSE 解析错误抛带上下文的 `Error`
- **重试**：429 / 5xx / 网络错误自动重试（`LlmConfig.maxRetries` 默认 2,设 0 关闭）,退避优先尊重 `Retry-After` 头（封顶 30s）,否则指数退避 500ms * 2^attempt；4xx 其他状态不重试；流式仅在连接建立前重试
- **超时**：`LlmConfig.timeoutMs`（毫秒,可选）,重试时刷新预算
- **取消**：请求参数 `signal` 透传到底层 HTTP；外部取消抛 `AgentAbortError`（用户取消,与超时/错误区分,不重试）。`AgentAbortError` 携带 `messages` 属性——中断时刻的部分对话历史（截至最后一个完整轮组）,供业务方持久化后经 `config.messages` 续跑,语义详见 [reactLoop.md](./reactLoop.md) 中断恢复章节

## 透传字段

`LlmConfig` 是嵌套级联结构（Phase 3.5）：provider 级字段（`apiKey` / `baseURL` + 索引签名字段如 `temperature`）共享给所有 model；model 级字段在 `models[modelName]` 里覆盖 provider 级同名字段。Provider 适配器把已知字段（`apiKey` / `baseURL` / `models`）作为连接配置,其余字段原样透传给 LLM API。

`LLMCompleteRequest` 的 `model` / `temperature` / `maxTokens` 优先级高于 `LlmConfig`（agent 自身 `config.model` 作为缺省 key,经 llms 解析出 provider + model）。

完整优先级（高 → 低）：[Agent.run](./agent.md) 的 `options.provider`（外部 provider,跳过 llms 解析,详见 [agentHandle.md](./agentHandle.md) 的「`options.provider` 外部 provider」章节）/ `options.model`（字符串 key,按解析规则定位 provider + model；未传时用 agent 元数据 `config.model` 作为缺省 key；外部 provider 存在时为原始 model 名原样透传）/ `options.temperature` / `options.maxTokens` > agent 元数据 `config.model` > `LlmConfig`（provider 级 + model 级字段）。`options` 由 [Agent](./agent.md) 在 `buildLoopConfig` 阶段应用,Provider 适配器收到的 `LLMCompleteRequest` 已是最终值——Provider 无需感知 options 层或 key 解析。详见 [agentHandle.md](./agentHandle.md) 的「`options.model` 字符串 key 解析规则」。

## 相关模块

- [providers/openai](./providers/openai.md) —— `'openai'` provider 的具体实现
- [reactLoop](./reactLoop.md) —— Phase 3.3，调 `complete` / `stream` 执行 ReAct 循环
- [agent](./agent.md) —— Phase 3.4，构造时持有 `LLMProvider` 实例
- faapi 核心 [configTypes](../../faapi/src/config/configTypes.md) —— `LlmConfig` 类型定义（Phase 2.4）
