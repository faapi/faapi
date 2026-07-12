# @faapi/mcp

## 1.0.0

### Major Changes

- 首次发布 @faapi/mcp——纯手写 MCP Server SDK，不依赖 @modelcontextprotocol/sdk。提供 Streamable HTTP transport（POST JSON-RPC / GET 405 / DELETE 销毁会话）、zod-native tool 定义（通过 zod v4 内置 toJSONSchema 转 JSON Schema）、MCP 协议核心方法（initialize / tools/list / tools/call / ping / notifications/initialized）、Session 管理（Mcp-Session-Id header，内存 Map + TTL 过期机制，默认 30 分钟惰性清理）、faapi 适配器（createMcpHandler / createMcpNodeHandler）。capabilities 声明 `listChanged: false`（v1 无 SSE 推送）。

### Minor Changes

- 将 `zod` 从 `dependencies` 改为 `peerDependencies`（运行时直接 import zod）。业务方需在项目 `package.json` 显式安装 `zod@^4`。
