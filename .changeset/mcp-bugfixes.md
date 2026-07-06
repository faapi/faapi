---
"@faapi/faapi": minor
"@faapi/mcp": patch
"@faapi/schema": patch
---

修复 MCP 实现中的 4 个问题

- `@faapi/mcp`：capabilities 声明 `listChanged: false`（v1 无 SSE 推送，原声明 true 与实现不一致）
- `@faapi/mcp`：SessionManager 加 TTL 过期机制（默认 30 分钟，惰性清理，防止内存泄漏）
- `@faapi/mcp`：修复 `createMcpNodeHandler` 多 chunk 响应体只发送第一个 chunk 的 bug（改用 `response.text()` 一次性读取）
- `@faapi/faapi`：PluginContext 新增 `getRoutes()` 方法，返回最新路由清单（`reloadRoutes` 后更新），`ctx.routes` 仍为 setup 时快照
- `@faapi/schema`：`createSchemaServer` 改用 `getRoutes` getter 替代路由快照，通过数组引用比较检测变更，dev 热替换后 schema 自动刷新
