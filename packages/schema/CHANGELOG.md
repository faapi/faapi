# @faapi/schema

## 1.0.0

### Major Changes

- 首次发布 @faapi/schema——基于 @faapi/mcp 实现，通过 MCP 协议（Streamable HTTP transport）暴露路由 schema 给 AI 助手。插件在 `/mcp` 路径挂载端点，AI 助手通过 HTTP 连接 `http://localhost:3000/mcp`。通过 `ctx.wrapHandler` 拦截 `/mcp` 路径，与 faapi 路由系统原生集成。`createSchemaServer` 通过 `getRoutes` getter 替代路由快照，dev 热替换后 schema 自动刷新。提供三个 tool：`list_routes`（列出所有路由）、`get_route_schema`（获取单个路由详细 schema）、`get_api_schema`（获取完整 API schema，类似 OpenAPI）。在 `faapi.config.ts` 的 `plugins` 字段声明即可加载。

### Minor Changes

- 删除冗余 `dependencies.zod`（不直接 import），改为 `peerDependencies` 保持一致。业务方需在项目 `package.json` 显式安装 `zod@^4`。
