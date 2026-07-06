# jsonRpc

一句话概括：JSON-RPC 2.0 协议消息类型、解析和响应构建工具

## 为什么需要

MCP 协议基于 JSON-RPC 2.0。所有通信都是 JSON-RPC 消息（Request / Notification / Response）。本模块提供类型定义、消息判定函数和响应构建工具，是 MCP Server 的协议基础。

## 使用场景

被 mcpServer.ts 和 streamableHttp.ts 内部使用：
- streamableHttp 解析 HTTP 请求体为 JSON-RPC 消息（parseJsonRpcMessage）
- mcpServer 构建响应（createResultResponse / createErrorResponse）
- 分离请求和通知（isRequest / isNotification）

## 核心类型

- **JsonRpcRequest**：有 id + method，期望响应
- **JsonRpcNotification**：有 method 无 id，不期望响应
- **JsonRpcResultResponse**：有 id + result，成功响应
- **JsonRpcErrorResponse**：有 id + error，错误响应
- **ErrorCode**：JSON-RPC 标准错误码（-32700 ~ -32603）+ MCP 扩展（-32000 ~ -32001）
- **JsonRpcError** / **JsonRpcMessage**：联合类型(已从 index.ts 导出,供业务方做类型收窄)
- **JsonRpcParseError**：解析错误类(继承 Error,包含 `code` 字段,`parseJsonRpcMessage` 解析失败时抛出,业务方可 `instanceof` 判定)

## 工具函数

| 函数 | 说明 |
|------|------|
| `parseJsonRpcMessage(text)` | 解析 JSON 字符串为 JSON-RPC 消息,失败抛 `JsonRpcParseError` |
| `createResultResponse(id, result)` | 构建成功响应 |
| `createErrorResponse(id, error)` | 构建错误响应 |
| `isRequest(msg)` | 判定是否为 Request(有 id + method) |
| `isNotification(msg)` | 判定是否为 Notification(有 method 无 id) |
| `isResultResponse(msg)` | 判定是否为成功响应(有 id + result) |
| `isErrorResponse(msg)` | 判定是否为错误响应(有 id + error) |

## 相关模块

- [mcpServer](./mcpServer.md) — 使用本模块的类型和工具函数分发 JSON-RPC 方法
- [streamableHttp](./streamableHttp.md) — 使用本模块解析 HTTP 请求体中的 JSON-RPC 消息
