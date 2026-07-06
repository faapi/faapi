---
"@faapi/mcp": major
---

新增 @faapi/mcp 包：纯手写 MCP Server SDK，不依赖 @modelcontextprotocol/sdk。

- Streamable HTTP transport（POST JSON-RPC / GET 405 / DELETE 销毁会话）
- zod-native tool 定义（通过 zod v4 内置 toJSONSchema 转 JSON Schema）
- MCP 协议核心方法：initialize / tools/list / tools/call / ping / notifications/initialized
- Session 管理（Mcp-Session-Id header，内存 Map）
- faapi 适配器（createMcpHandler 返回 POST/GET/DELETE handler）
