---
'@faapi/mcp': patch
---

MCP Streamable HTTP transport：GET（打开 SSE 流）现在校验 `Accept` 头必须包含 `text/event-stream`，缺失返回 406 InvalidRequest——MCP 2025-06-18 规范要求，与 POST 的双类型校验对称（此前仅 POST 侧实现）。直接用 `fetch` 裸调 GET 端点的客户端需要补 `Accept: text/event-stream` 头；官方 SDK 与浏览器 `EventSource` 默认携带该头，不受影响。
