---
'@faapi/agent': minor
'@faapi/faapi': patch
---

agent 子系统 LLM 调用层新增超时、重试与取消支持（生产长任务稳定性）：

- **取消（AbortSignal）**：`agent.run/stream` 的 options 新增 `signal`，沿 agentHandle → Agent → reactLoop → provider 透传到底层 HTTP 请求。循环每轮开始前预检查，执行中取消请求中断并抛 `AgentAbortError`（新导出）——业务方通过 `instanceof` 区分用户取消与真实错误（SSE/WS 客户端断开后不再白烧 token）
- **超时**：`LlmConfig.timeoutMs`（毫秒，可选，未设置时无超时），provider 层用 `AbortSignal.timeout` 实现，与 run-level `signal` 组合生效；超时触发抛 `LLMProviderError`（message 含 timed out）
- **重试**：429 / 5xx / 网络错误自动重试，`LlmConfig.maxRetries`（默认 2，设 0 关闭）。退避优先尊重响应 `Retry-After` 头（封顶 30s），否则指数退避 500ms × 2^attempt；4xx 其他状态（400/401 等）确定性错误不重试；流式仅在连接建立前重试，每次重试刷新超时预算
- **流取消**：stream 提前终止（消费者 break）时主动 `reader.cancel()` 释放底层 HTTP 连接，不再等待 body 缓冲耗尽
