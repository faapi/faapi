# streamableHttp

一句话概括：Streamable HTTP transport——Web Request → JSON-RPC → Response

## 为什么需要

MCP Streamable HTTP transport 规范要求单端点支持 POST/GET/DELETE。本模块接收 Web API Request，解析 JSON-RPC，调用 mcpServer 处理，返回 Web API Response。

## 使用场景

直接在 faapi handler 中使用：
```ts
export function POST(ctx) {
  return handleMcpRequest(ctx.request, mcp);
}
```

或通过 faapiAdapter 的 `createMcpHandler(mcp)` 自动生成 POST/GET/DELETE。

## HTTP 方法处理

| 方法 | 行为 |
|------|------|
| POST | 解析 JSON-RPC，分发到 mcpServer，返回 JSON 响应或 202（通知） |
| GET | 打开 SSE 流(200 + text/event-stream),定期发心跳保持连接;客户端断开时清理资源 |
| DELETE | 按 Mcp-Session-Id 销毁会话 |

## 协议头校验

### Accept 头(POST)

MCP 2025-06-18 规范要求 POST 请求的 `Accept` 头必须同时包含 `application/json` 和 `text/event-stream`,以告知服务端客户端能接受哪些响应格式。

- 缺失 `Accept` 头 → 400 `InvalidRequest`
- 缺少 `application/json` 或 `text/event-stream` → 400 `InvalidRequest`
- initialize 请求豁免(首次握手允许只接受 JSON)

### MCP-Protocol-Version 头

initialize 响应通过 `result.protocolVersion` 返回协商版本,后续请求由客户端在 `Mcp-Session-Id` 维度的 session 中保持版本状态,服务端不再逐请求校验 `MCP-Protocol-Version` 头。

## GET SSE 流

GET 请求返回 200 + `text/event-stream` 响应,通过 `ReadableStream` 持续推送心跳(`: keepalive\n\n`)维持连接。

- **心跳间隔**:默认 30 秒,通过 `createMcpServer({ sseHeartbeatMs })` 配置
- **客户端断开**:stream `cancel` 触发,清理定时器 + 注销订阅者
- **响应头**:`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`

### 订阅者注册

GET 请求若携带 `Mcp-Session-Id` 头,会在 stream `start` 时通过 `SessionManager.addSubscriber(sessionId, controller)` 注册订阅者:

- 服务端调用 `sendLogging` / `sendResourceUpdated` 等推送方法时,通过 `broadcastToSession` 将通知消息推送到所有订阅者的 controller
- 客户端断开(stream `cancel`)时,通过 `removeSubscriber` 注销,避免内存泄漏
- GET 请求无 `Mcp-Session-Id` 时,仅维持心跳连接(不注册订阅者,无法接收业务推送)

### 推送消息格式

服务端推送的 JSON-RPC 通知以 SSE `data:` 行格式发送:

```
data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","logger":"tool:hello","data":{...}}}\n\n
```

业务方可通过 `extra.sendLogging` (tool/resource/prompt handler) 或 `server.sendLogging` (应用级) 触发推送。

## Session 管理

- initialize 请求：创建 session，通过 Mcp-Session-Id 响应头返回
- 后续请求：从 Mcp-Session-Id 请求头查找 session
- 不存在的 session ID：返回 404

## 错误处理

- 非 JSON 请求体 → 400 ParseError
- 非法 JSON-RPC 消息 → 400 ParseError
- 重复 initialize → 400 InvalidRequest

## 相关模块

- [mcpServer](./mcpServer.md) — 调用 `handleJsonRpc` 分发请求
- [jsonRpc](./jsonRpc.md) — 调用 `parseJsonRpcMessage` 解析请求体
- [faapiAdapter](./faapiAdapter.md) — 封装为 faapi handler
