---
'@faapi/mcp': patch
---

MCP JSON-RPC 错误码与边界向规范对齐：

- 批量消息内单条无效的错误码由 `ParseError(-32700)` 改为 `InvalidRequest(-32600)`——JSON-RPC 2.0 规范 §4.4 中 -32700 保留给整体 JSON 文本解析失败，批内单条结构不合法属 Invalid Request；空批与单条结构不合法的 400 响应同样改为 -32600
- `id: null` 的 method 消息（规范弃用但合法的形态）按 request 接受并以 `id: null` 回传响应（与官方 SDK 同语义）——此前落进 "unknown message shape" 抛错；`JsonRpcRequest.id` / `JsonRpcResultResponse.id` 类型放宽为 `string | number | null`
