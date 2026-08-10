# @faapi/mcp — MCP Server SDK

纯手写 MCP（Model Context Protocol）Server SDK，不依赖 `@modelcontextprotocol/sdk`，仅依赖 `zod`。

## 模块结构

```
jsonRpc ─┐
         ↓
session ─→ mcpServer ─→ faapiAdapter
              ↑
         streamableHttp
```

| 模块 | 职责 |
|------|------|
| [jsonRpc.ts](./jsonRpc.md) | JSON-RPC 2.0 协议类型、消息判定与响应构建工具——MCP 通信的协议基础 |
| [session.ts](./session.md) | 会话管理（内存 Map + TTL 自动过期 + SSE 订阅者）——支持 Streamable HTTP transport 的有状态会话 |
| [mcpServer.ts](./mcpServer.md) | MCP Server 核心——tool/resource/prompt/completion/method 注册 + JSON-RPC 方法分发 + 通知推送 |
| [streamableHttp.ts](./streamableHttp.md) | Streamable HTTP transport——Web Request → JSON-RPC → Response（单端点支持 POST/GET/DELETE） |
| [faapiAdapter.ts](./faapiAdapter.md) | faapi 适配器——把 McpServer 包装为 faapi handler 风格函数（`createMcpHandler` / `createMcpNodeHandler`） |

## 依赖关系

- `jsonRpc` 是协议基础，被 `mcpServer` 和 `streamableHttp` 共用
- `session` 被 `streamableHttp` 和 `mcpServer` 共用（前者管生命周期，后者读写会话状态）
- `mcpServer` 是核心，聚合 `jsonRpc` + `session`
- `streamableHttp` 是 transport 层，调用 `mcpServer.handleJsonRpc`
- `faapiAdapter` 是适配层，把 `streamableHttp` 包装为 faapi handler

## 典型用法

```ts
import { createMcpServer, createMcpHandler } from '@faapi/mcp';
import { z } from 'zod';

const mcp = createMcpServer({ name: 'my-server', version: '1.0.0' });

mcp.tool('echo', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text }],
}));

// api/mcp/handler.ts
export const POST = createMcpHandler(mcp);
```

## 设计要点

- **不依赖 `@modelcontextprotocol/sdk`**——纯手写 MCP 协议，减少运行时依赖
- **仅依赖 `zod`**——tool 输入参数用 zod raw shape 注册，运行时校验
- **Streamable HTTP transport**——单端点支持 POST（请求/通知）/ GET（SSE 订阅）/ DELETE（会话销毁），符合 MCP 规范
- **会话隔离**——通过 `Mcp-Session-Id` header 维持有状态会话，支持 SSE 订阅者与日志级别协商
