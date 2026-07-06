# @faapi/mcp

> MCP Server SDK for faapi — 不依赖 @modelcontextprotocol/sdk，纯手写 MCP 协议

`@faapi/mcp` 实现 MCP（Model Context Protocol）服务端，通过 Streamable HTTP transport 暴露 tool 给 AI 助手（如 Claude、Cursor）。用 zod 声明 tool 输入参数，自动转为 JSON Schema。

## 安装

```bash
pnpm add @faapi/mcp
```

要求 Node.js >= 24。

## 快速开始

在 faapi 应用中创建 MCP 端点：

```ts
// api/mcp/handler.ts
import { createMcpServer, createMcpHandler } from '@faapi/mcp';
import { z } from 'zod';

const mcp = createMcpServer({ name: 'my-app', version: '1.0.0' });

mcp.tool('hello', {
  description: 'Say hello',
  input: { name: z.string().describe('Name to greet') },
  handler: async ({ name }) => ({
    content: [{ type: 'text', text: `Hello, ${name}!` }],
  }),
});

export const { POST, GET, DELETE } = createMcpHandler(mcp);
```

启动后，MCP 端点在 `/api/mcp` 可用，AI 助手通过 Streamable HTTP 连接。

## MCP 方法

| 方法 | 行为 |
|------|------|
| `initialize` | 协议握手，返回 serverInfo + capabilities |
| `tools/list` | 列出所有 tool（含 JSON Schema） |
| `tools/call` | 调用 tool，返回结果 |
| `ping` | 心跳 |

## Transport

仅支持 Streamable HTTP（MCP 2025-06-18 规范）：

- **POST**：发送 JSON-RPC 消息，返回 JSON 响应
- **GET**：v1 返回 405（不支持独立 SSE 流）
- **DELETE**：按 `Mcp-Session-Id` 销毁会话

## 与 @modelcontextprotocol/sdk 的区别

| 方面 | @modelcontextprotocol/sdk | @faapi/mcp |
|------|--------------------------|------------|
| Transport | stdio + Streamable HTTP + 旧版 SSE | 仅 Streamable HTTP |
| 依赖 | @modelcontextprotocol/sdk + zod-to-json-schema | 仅 zod（v4 内置 toJSONSchema） |
| 集成 | 独立进程 | faapi 路由（函数即接口） |
| Tool 定义 | `server.tool(name, schema, cb)` | `mcp.tool(name, { input, handler })` |

## 许可证

[MIT](https://github.com/faapi/faapi/blob/main/LICENSE)
