---
"@faapi/schema": major
---

重写 @faapi/schema 基于 @faapi/mcp 实现，移除 @modelcontextprotocol/sdk 依赖。

- 传输方式从 stdio 改为 Streamable HTTP（MCP 2025-06-18 规范），插件在 `/mcp` 路径挂载端点
- AI 助手通过 HTTP 连接 `http://localhost:3000/mcp`，不再需要独立 stdio 进程
- 依赖 `@faapi/mcp`（workspace），不再依赖 `@modelcontextprotocol/sdk`
- 插件通过 `ctx.wrapHandler` 拦截 `/mcp` 路径，与 faapi 路由系统原生集成
