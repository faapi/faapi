---
'@faapi/faapi': minor
---

SSE 响应头新增 `X-Accel-Buffering: no`：nginx 反代默认 `proxy_buffering on` 会把 SSE 小包攒到流结束才一次性下发，逐事件语义失效（LLM 流式场景表现为整个生成期间客户端无输出、结束瞬间全部到达）。该头让 nginx 按响应跳过缓冲，事件即产即达；其他反代与直连客户端忽略该头，无副作用。handler 仍可通过 `ctx.setHeader('X-Accel-Buffering', 'yes')` 覆盖默认值。
