# routeSchema

一句话概括：从路由清单生成接口 schema 描述，供 MCP server 暴露给 LLM。

## 为什么需要

MCP server 需要结构化的路由信息供 LLM 查询。本模块直接调用主包 `collectRouteSchemaSources` 执行 AST 分析，提取每个路由 handler 的输入参数类型，把路由清单转换为包含参数类型详情的 RouteInfo[]，不依赖运行时 schemaRegistry。

## 使用场景

`createSchemaServer` 初始化时调用，构建路由 schema 缓存供 MCP tool 查询。

## 架构

```
RouteManifest
  → collectRouteSchemaSources（AST 从源码 .ts 提取每个 handler 的类型）
  → buildRouteSchemas（遍历路由清单，按 urlPath#schemaName 匹配提取结果）
  → getInputTypeForMethod（确定主输入类型：GET/DELETE/HEAD → query，其余 → body）
  → toParamSchemas（PropertyType[] → RouteParamSchema[]）
  → RouteInfo[]（缓存）
  → MCP tool 查询时返回
```

动态路由无 params 类型声明时，用 `route.paramNames` 兜底为 `string[]`。

## 相关模块

- [@faapi/faapi](../../faapi/) - 提供公开能力：`collectRouteSchemaSources`（AST 提取路由 schema 源数据）、`getInputTypeForMethod`、`RuntimeType` / `PropertyType` 类型
- [schemaServer.ts](./schemaServer.md) - 消费 RouteInfo[]，通过 MCP 暴露给 LLM
