---
'@faapi/agent': minor
---

agent 子系统支持 thinking（推理内容）：OpenAI provider 解析 thinking 模型的推理输出（`reasoning_content` 线格式优先，兼容 OpenRouter 的 `reasoning`），非流式经 `LLMMessage.reasoning_content` 与 `ReactLoopResult.reasoning` 透出，流式经 `LLMStreamChunk.deltaReasoning` / `done.reasoning` 逐段透传；推理内容不回传 LLM API（请求侧剥离）也不进入对话历史（续跑 / 持久化历史保持 OpenAI 线格式纯净），仅 trace 的 `llm_call.response` 保留完整原始返回供观测。
