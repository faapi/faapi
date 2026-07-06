# @faapi/schema

> 将 faapi 路由 schema 通过 MCP 协议暴露给 AI 助手

`@faapi/schema` 是 faapi 的扩展包，基于 [`@faapi/mcp`](../mcp/)（纯手写 MCP Server SDK）构建 MCP Server，通过 Streamable HTTP transport 在 `/mcp` 端点暴露路由 schema，让 AI 助手（如 Claude、Codex）能查询你的 API 路由结构、参数类型，无需阅读源代码即可理解接口定义。

不依赖 `@modelcontextprotocol/sdk`，MCP 协议层完全由 `@faapi/mcp` 实现。

## 安装

```bash
pnpm add @faapi/schema
# 或
npm install @faapi/schema
```

要求 Node.js >= 24。

## 快速开始

在 `faapi.config.ts` 中声明插件：

```ts
export default {
  plugins: ['@faapi/schema'],
} satisfies FaapiConfig;
```

启动 dev server 后，MCP 端点自动挂载到 `/mcp` 路径。插件声明即为开关——不需要时从 `plugins` 数组移除即可，也可用 `{ package: '@faapi/schema', enable: false }` 临时禁用。

## MCP 工具

| 工具名 | 功能 |
|--------|------|
| `list_routes` | 列出所有 HTTP 路由（方法、路径、是否动态路由） |
| `get_route_schema` | 获取单个路由的详细输入参数（名称、类型、是否必填） |
| `get_api_schema` | 获取所有路由的完整 schema（类似 OpenAPI） |

## MCP 客户端配置

AI 助手通过 Streamable HTTP 连接到 `http://localhost:3000/mcp`（端口取决于 `PORT` 环境变量）。以支持 HTTP transport 的 MCP 客户端为例：

```json
{
  "mcpServers": {
    "faapi": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

连接流程：`POST /mcp` 发送 `initialize` 请求 → 从响应 `Mcp-Session-Id` header 获取会话 ID → 后续 `tools/list`、`tools/call` 请求携带该 header → `DELETE /mcp`（带 session header）销毁会话。

## 许可证

[MIT](https://github.com/faapi/faapi/blob/main/LICENSE)
