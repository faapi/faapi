---
'@faapi/faapi': minor
---

feat(sse): `ctx.sse()` 新增 `keepOpen` 选项与 `SseWriter.onClose()`——支持「handler 先返回、流保持打开」的长连接订阅模式

此前 handler 返回时框架无条件自动 close 未关闭的 SSE writer（防泄漏兜底），导致订阅型端点（handler 把连接挂到事件总线/change stream 后立即返回，连接长存）在返回瞬间被掐断，业务方只能让 handler 挂到流结束才能返回。

- `ctx.sse({ keepOpen: true })`：声明流生命周期独立于 handler 返回——返回后框架不再自动 close，连接长存直到显式 `close()`、客户端断开或 handler 抛错兜底；默认行为不变（返回即自动 close），存量零影响。
- `sse.onClose(callback)`：流结束回调，显式 close / 框架兜底 / 客户端断开 / sendError 任一路径结束流时恰好触发一次，注册时流已结束则立即触发——keepOpen 模式下用于退订/清理推送源。
- handler 抛错路径的兜底 close 不受 keepOpen 影响，仍无条件关闭（注册流程失败后无人持有 writer，悬挂无意义）。
