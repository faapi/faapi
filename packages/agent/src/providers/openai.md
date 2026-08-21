# providers/openai

一句话概括：OpenAI 兼容 API 的 LLMProvider 实现——`complete` 走 `/chat/completions`，`stream` 解析 SSE chunks，支持 tool calling，可指向任何 OpenAI 兼容中转服务。

## 为什么需要

OpenAI 的 chat completions API 已成为事实标准——Anthropic、Google、阿里通义、智谱、本地 LiteLLM / Ollama 等都提供 OpenAI 兼容端点。实现一个 OpenAI 兼容 provider 就能覆盖绝大多数 LLM 服务，无需为每个 provider 写独立适配器。

通过 `LlmConfig.baseURL` 字段指向任意 OpenAI 兼容中转：

- 官方 OpenAI：`https://api.openai.com/v1`（默认）
- Azure OpenAI：`https://<resource>.openai.azure.com/openai/deployments/<deployment>`
- 中转服务（如 LiteLLM / one-api / 自建网关）：任意 HTTPS URL

## 使用场景

- [createProvider](../provider.md) 在 `config.provider === 'openai'` 时创建此 provider
- [reactLoop](../reactLoop.md) 调 `complete` 发送 messages + tools 拿回 tool_calls
- [Agent 类](../agent.md) 流式模式调 `stream` 逐 token 推送给 SSE 客户端

## 设计

### `createOpenAIProvider(config: LlmConfig): LLMProvider`

工厂函数，持有 `LlmConfig`（apiKey / model / baseURL / 透传字段），返回 `LLMProvider` 接口实现。

### `complete(request)` 流程

1. 构造请求体：`messages`（转换 `LLMMessage` → OpenAI 格式）+ 可选 `tools`（OpenAI function calling 格式）+ `model`（request.model ?? config.model）+ 透传字段
2. POST `${baseURL ?? 'https://api.openai.com/v1'}/chat/completions`
3. Headers：`Authorization: Bearer ${apiKey}` + `Content-Type: application/json`
4. 解析响应 JSON：取 `choices[0].message`，转换 `tool_calls`（JSON.parse 每个 `arguments` 字符串）
5. 映射 `finish_reason` → `stopReason`：`stop` → `stop`，`tool_calls` → `tool_calls`，`length` → `length`，`content_filter` → `content_filter`，其他 → `other`
6. 返回 `LLMResponse`（message + stopReason + usage）

### `stream(request)` 流程

1. 构造请求体（同 complete + `stream: true`）
2. POST + 读 `response.body`（ReadableStream）
3. 用 `TextDecoder` + 缓冲区解析 SSE：按 `\n\n` 分割事件，每行 `data: <json>` 或 `data: [DONE]`
4. 对每个 chunk：
   - `delta.content` → emit `{ deltaContent: chunk }`
   - `delta.tool_calls` → 按 `index` 累积 `id` / `function.name` / `function.arguments`（字符串拼接）
   - `finish_reason` → 标记结束
5. 流结束前 emit 最终 chunk：`{ toolCalls: accumulated[] | undefined, finishReason, usage }`
6. `[DONE]` 行 → 终止迭代

### 消息格式转换

`LLMMessage` → OpenAI 格式：

| LLMMessage.role | OpenAI role | 额外字段 |
| --- | --- | --- |
| `system` | `system` | `content` |
| `user` | `user` | `content` |
| `assistant` | `assistant` | `content` + 可选 `tool_calls`（`{ id, type: 'function', function: { name, arguments: JSON.stringify } }`） |
| `tool` | `tool` | `content` + `tool_call_id` |

OpenAI → `LLMMessage`（响应解析）：

- `message.content` → `LLMMessage.content`（可能为 `null`，统一为 `''`）
- `message.tool_calls` → `LLMMessage.toolCalls`（每个 `arguments` 字符串 `JSON.parse`，失败抛错）

### Tool 定义转换

`LLMToolDefinition` → OpenAI `tools` 字段：

```json
[{
  "type": "function",
  "function": {
    "name": "<name>",
    "description": "<description>",
    "parameters": <input JSON Schema>
  }
}]
```

### 错误处理

- `fetch` 抛 TypeError（网络错误）→ 包成 `LLMProviderError("Network error: <reason>")`
- 非 2xx HTTP → 抛 `LLMProviderError`（含 status + body 前 500 字符摘要）
- 响应 JSON 解析失败 → 抛 `LLMProviderError("Invalid JSON response: <body 摘要>")`
- `choices` 为空 / `choices[0].message` 缺失 → 抛 `LLMProviderError("Empty choices in response")`
- `tool_calls[].function.arguments` JSON.parse 失败 → 抛 `LLMProviderError("Invalid tool arguments JSON: <raw>")`
- SSE chunk JSON 解析失败 → 抛 `LLMProviderError("Invalid SSE chunk: <raw>")`

`LLMProviderError` 含 `status` 字段（HTTP 状态码，网络错误为 `undefined`）+ `body` 字段（响应体摘要）。

## 相关模块

- [provider](../provider.md) —— LLMProvider 接口与 createProvider 工厂
- [reactLoop](../reactLoop.md) —— Phase 3.3，消费 complete / stream
- faapi 核心 [configTypes](../../../faapi/src/config/configTypes.md) —— `LlmConfig` 类型
