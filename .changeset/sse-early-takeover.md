---
"@faapi/faapi": patch
---

修复 `ctx.sse()` 流式响应延迟接管：首次写入即接入连接，字节即产即达

此前 SSE Response 要等 handler 返回后才交给发送层 pipe 到底层连接——流式期间 `ReadableStream` 无消费者，`send`/`sendRaw` 的字节全部积压到 handler 结束才一次性到达，流式语义失效（LLM 打字机/思考过程增量变成一次性到达）；`sse.aborted` 也因 cancel 永不触发而在 handler 执行期间恒为 false，「客户端断开退出推送循环」的写法实际失效。

现改为**首次写入接管**（flush-on-first-send）：HTTP 服务场景下首次 `send`/`sendRaw`/`sendError` 触发时即把 SSE Response（含 `text/event-stream` 头）接入底层连接并开始 pipe。边界变化：

- 首次写入前 handler 抛错仍走错误兜底链（500）；首次写入后响应已开始，handler 抛错时关闭流终止连接（已推事件照常送达），不再改发错误响应，`onError` 钩子仍触发
- `ctx.setStatus`/`setHeader` 需在首次写入前调用；接管后中间件 `await next()` 之后替换的响应被忽略（日志等副作用仍正常）
- `app.inject()` / 测试直调 `invokeHandler` 无提前接管通道，回落为 handler 返回后一次交出——`app.inject()` 等流结束整体返回，最终字节序列与真实请求一致
