---
"@faapi/faapi": minor
---

ctx.request.signal 接线客户端断连——非流式 handler 可感知客户端提前断开

每个请求的 `ctx.request.signal`（标准 Web AbortSignal）已接线到连接生命周期：客户端提前断开（响应未写完连接即 close）时信号触发，响应正常完成不误触发。非流式 handler 的长耗时上游调用携带该信号（`fetch(url, { signal: ctx.request.signal })`），客户端取消即中止上游（LLM 网关转发、批量任务等场景）。此前断连检测仅存在于 SSE 路径（`ctx.sse().aborted`），非流式 POST 只能靠业务侧超时兜底，客户端取消后上游继续执行。SSE 路径行为不变，两者并存。
