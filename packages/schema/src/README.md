# @faapi/schema — 路由 Schema MCP 扩展

可选扩展包，通过 MCP 协议（Streamable HTTP）将 faapi 路由 schema 以 resource 形式暴露给 AI 助手查询。

## 模块结构

```
routeSchema ─┐
             ↓
         schemaServer ──→ MCP resource（/mcp 端点）
             ↓
         @faapi/mcp（createMcpServer + createMcpNodeHandler）
```

| 模块 | 职责 |
|------|------|
| [routeSchema.ts](./routeSchema.md) | 从路由清单生成接口 schema 描述——调用主包 `collectRouteSchemaSources` 执行 AST 分析，提取每个 handler 的输入参数与返回类型，生成 `RouteInfo[]` |
| [schemaServer.ts](./schemaServer.md) | MCP server 装配——把 `RouteInfo[]` 注册为 MCP resource / resourceTemplate，挂载到 faapi 插件的 `/mcp` 路径 |

## 依赖关系

- **`@faapi/faapi`（peerDependencies）**：复用主包公开的 AST 能力（`createProgram` / `extractTypeInfo` / `collectRouteSchemaSources`），不依赖主包内部模块
- **`@faapi/mcp`（dependencies）**：基于纯手写 MCP Server SDK 暴露 resource

## 启用方式

在 `faapi.config.ts` 的 `plugins` 中声明即启用：

```ts
export default {
  plugins: ['@faapi/schema'],
} satisfies FaapiConfig;
```

CLI 启动时动态加载——未安装时自动跳过，不影响核心功能。需单独安装：`pnpm add @faapi/schema`。

## 设计要点

- **resource 而非 tool**——查 schema 本质是读数据（resource 语义），不是执行动作（tool 语义）。AI 客户端对 resource 有原生 UI 展示、缓存、subscription 支持
- **每个路由 = 一个静态 resource + 按方法过滤的 resourceTemplate**——支持 `resources/list` / `resources/read` / `resources/subscribe`
- **completion 支持**——为 resourceTemplate 的参数提供自动补全候选值
- **schema 缓存**——`createSchemaServer` 初始化时构建 `RouteInfo[]` 缓存，后续 MCP 查询直接读缓存
