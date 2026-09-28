---
"@faapi/agent": patch
---

修复 OpenAI provider `stream()` 对截断流的静默 finalize：无 `[DONE]` 且无 `finish_reason` 的流结束现在抛 `LLMProviderError`

此前流自然结束（`done=true`）时无条件 `finalizeStreamChunk`——上游/网关中途掐断连接时，部分累积的 tool_calls / 内容会冒充完整响应返回，截断轮次静默污染 agent 历史（主控拿到残缺的子代理回报后照常推进）。

现改为两道防御：

- 流自然结束但既无 `[DONE]` 也无 `finish_reason` → 抛 `LLMProviderError`（truncated upstream stream）。仅缺 `[DONE]` 但有 `finish_reason` 视为省略哨兵的完整流（部分 OpenAI 兼容上游不发 `[DONE]`），保持兼容
- chunk 携带非空 `error` 字段（OpenAI 生态惯例线格式 `data: {"error":{...}}`，网关/上游中断时下发）→ 原样抛出并携带上游错误文本，不再被静默忽略

配合网关侧「流中途异常先发错误事件再关流」的信号（如 llm 中转网关），截断轮次从静默污染变为带可读原因的显式失败，由调用方决定重试。
