# routeSchema

一句话概括：从路由清单生成接口 schema 描述，供 MCP server 暴露给 LLM。

## 为什么需要

MCP server 需要结构化的路由信息供 LLM 查询。本模块复用主包 `schemaRegistry` 已提取的类型信息，把路由清单转换为包含参数类型详情的 RouteInfo[]，不重复执行 AST 分析。

## 使用场景

`createSchemaServer` 初始化时调用，构建路由 schema 缓存供 MCP tool 查询。

## 架构

```
RouteManifest
  → buildRouteSchemas（遍历路由清单）
  → getInputTypeForMethod（确定主输入类型：GET/DELETE/HEAD → query，其余 → body）
  → getSchemaProperties（从 schemaRegistry 读取已提取的 PropertyType）
  → RouteInfo[]（缓存）
  → MCP tool 查询时返回
```

动态路由额外查询 `getSchemaProperties(filePath, method, 'params')`；若未声明 params 类型，则用 `route.paramNames` 兜底为 `string[]`。

## 相关模块

- [@faapi/faapi](../../faapi/) - 提供公开能力：`getSchemaProperties`（读取 `schemaRegistry` 已提取的类型）、`getInputTypeForMethod`
- [schemaServer.ts](./schemaServer.md) - 消费 RouteInfo[]，通过 MCP 暴露给 LLM
