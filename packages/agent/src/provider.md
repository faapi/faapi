# provider

一句话概括：LLM Provider 抽象层——统一 `complete` / `stream` 接口，屏蔽 OpenAI / Anthropic 等 LLM 服务差异，让 reactLoop 与 Agent 类对 LLM 无关。

## 为什么需要

[reactLoop](./reactLoop.md)（Phase 3.3）与 [Agent 类](./agent.md)（Phase 3.4）需要把 messages + tools 发给 LLM，并拿回 assistant 消息（含可能的 `tool_calls`）。但 LLM 服务有差异：

- OpenAI / Azure OpenAI / 本地 LiteLLM / 阿里通义 / 智谱 → OpenAI 兼容 API
- Anthropic Claude → Messages API（与 OpenAI 不同）
- Google Gemini → generateContent API

直接在 reactLoop 里 `fetch` OpenAI 会让 LLM 服务耦合死，且未来加 provider 要改 reactLoop。`LLMProvider` 接口把"如何调用 LLM"封装在 provider 适配器里，reactLoop 只看抽象接口。

## 使用场景

- [reactLoop](./reactLoop.md) 每轮调 `provider.complete()` 或 `provider.stream()` 发送 messages + tools，拿回 assistant 消息
- [Agent 类](./agent.md) 构造时接收 `LLMProvider` 实例（由 [createProvider](#createprovider) 工厂创建），传给 reactLoop
- 业务方自定义 provider：实现 `LLMProvider` 接口即可对接任意 LLM 服务（如内部自研模型网关）

## 设计

### 核心类型

| 类型 | 说明 |
| --- | --- |
| `LLMMessage` | 对话消息（role + content + 可选 tool_calls / toolCallId） |
| `LLMToolCall` | LLM 请求的 tool 调用（id + name + arguments 已 JSON.parse） |
| `LLMToolDefinition` | tool 定义（name + description + JSON Schema input） |
| `LLMCompleteRequest` | complete / stream 的入参（messages + tools + 可选 model / temperature / maxTokens） |
| `LLMResponse` | complete 的返回（message + stopReason + usage） |
| `LLMStreamChunk` | stream 的单个 chunk（deltaContent + toolCalls + finishReason + usage） |
| `LLMUsage` | token 用量（promptTokens + completionTokens + totalTokens） |

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
- **取消**：请求参数 `signal` 透传到底层 HTTP；外部取消抛 `AgentAbortError`（用户取消,与超时/错误区分,不重试）

## 透传字段

`LlmConfig` 是嵌套级联结构（Phase 3.5）：provider 级字段（`apiKey` / `baseURL` + 索引签名字段如 `temperature`）共享给所有 model；model 级字段在 `models[modelName]` 里覆盖 provider 级同名字段。Provider 适配器把已知字段（`apiKey` / `baseURL` / `models`）作为连接配置,其余字段原样透传给 LLM API。

`LLMCompleteRequest` 的 `model` / `temperature` / `maxTokens` 优先级高于 `LlmConfig`（agent 自身 `config.model` 覆盖 `defaultLlm` provider 的默认 model）。

完整优先级（高 → 低）：[Agent.run](./agent.md) 的 `options.model`（字符串 key,按解析规则定位 provider + model）/ `options.temperature` / `options.maxTokens` > agent 元数据 `config.model` > `LlmConfig`（`defaultLlm` provider 级 + model 级字段）。`options` 由 [Agent](./agent.md) 在 `buildLoopConfig` 阶段应用,Provider 适配器收到的 `LLMCompleteRequest` 已是最终值——Provider 无需感知 options 层或 key 解析。详见 [agentHandle.md](./agentHandle.md) 的「`options.model` 字符串 key 解析规则」。

## 相关模块

- [providers/openai](./providers/openai.md) —— `'openai'` provider 的具体实现
- [reactLoop](./reactLoop.md) —— Phase 3.3，调 `complete` / `stream` 执行 ReAct 循环
- [agent](./agent.md) —— Phase 3.4，构造时持有 `LLMProvider` 实例
- faapi 核心 [configTypes](../../faapi/src/config/configTypes.md) —— `LlmConfig` 类型定义（Phase 2.4）
