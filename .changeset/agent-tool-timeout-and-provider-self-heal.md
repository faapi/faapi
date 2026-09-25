---
'@faapi/agent': minor
---

agent tool 执行超时 + LLM 坏 JSON 参数自愈路径修复：

- 新增 `AgentRuntimeConfig.toolTimeoutMs`：单次 tool 执行超时毫秒数（未设置 = 不限时，行为不变）。超时抛新增的 `AgentToolTimeoutError`（公开导出），被 reactLoop 按既有 tool 错误路径回传 LLM——挂死的 tool handler（如无超时的内部 fetch）此前会让整个 run 永久挂起，且 run 的 abort signal 对 tool 执行无效
- **OpenAI provider 不再对 tool_calls.arguments 做 fail-fast JSON 预校验**（非流式 `normalizeToolCalls` 与流式 `finalizeStreamChunk` 两处）：maxTokens 截断产生的半截 JSON 此前会在 provider 边界抛 `LLMProviderError` 让整个 run 死亡，reactLoop 宣称的"解析失败回传 LLM 自愈"路径不可达；现在半截 JSON 原样透传，由 reactLoop 的 per-tool 错误路径把解析失败回传 LLM（LLM 可修正参数重试）。若业务方依赖捕获 `LLMProviderError` 处理坏参数，请改为在 tool 结果消费侧处理
- `afterToolCall` 审计钩子自身抛错改为只 `console.error` 留痕——此前钩子在结果返回前同步调用且无隔离，审计系统故障会把成功的 tool 结果变成错误回传 LLM（执行语义被审计钩子劫持，LLM 拿到审计报错还可能重试）
