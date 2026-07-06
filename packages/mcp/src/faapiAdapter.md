# faapiAdapter

一句话概括：把 MCP Server 挂载到 faapi 路由（handler 风格 + Node.js 适配）

## 为什么需要

faapi 的"函数即接口"理念下，MCP endpoint 就是一个路由。本模块提供适配器，把 McpServer 包装为 faapi 兼容的 handler 函数。

## 两种适配方式

**1. handler 风格（推荐）**：在 handler.ts 中导出

```ts
// api/mcp/handler.ts
import { createMcpServer, createMcpHandler } from '@faapi/mcp';

const mcp = createMcpServer({ name: 'my-app', version: '1.0.0' });
export const { POST, GET, DELETE } = createMcpHandler(mcp);
```

`createMcpHandler` 返回的函数参数名为 `ctx`，faapi 按参数名注入完整请求上下文，函数内通过 `ctx.request` 获取 Web Request 交给 streamableHttp 处理。

**2. Node.js 适配**：供插件的 wrapHandler 使用

`createMcpNodeHandler(mcp)` 返回接收 Node.js IncomingMessage/ServerResponse 的处理函数，用于 faapi 插件通过 `ctx.wrapHandler` 拦截指定路径。

## 多 chunk body 读取

`createMcpNodeHandler` 使用 Node.js 原生 `Readable.toWeb(req)` 将 IncomingMessage 转为 Web ReadableStream,正确处理 chunked transfer encoding(多个 data chunk)、backpressure 和 stream error。转换后的 stream 直接作为 Web Request 的 body,由 `Request.json()` 原生消费,无需手动累积 Buffer。

## 相关模块

- [streamableHttp](./streamableHttp.md) — 核心 HTTP 处理逻辑
- [mcpServer](./mcpServer.md) — McpServer 实例
