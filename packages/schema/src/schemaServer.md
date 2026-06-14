# schemaServer

一句话概括：通过 MCP 协议暴露路由 schema 供 AI 助手查询

## 为什么需要

AI-Native 定位，LLM 可直接查询 API 接口定义，无需手动提供文档

## 使用场景

dev 模式默认启用（FAAPI_SCHEMA 环境变量控制）；提供 list_routes、get_route_schema、get_api_schema 三个 tool

## 环境变量

| 条件 | 结果 |
| --- | --- |
| `FAAPI_SCHEMA=1` 或 `FAAPI_SCHEMA=true` | 强制开启 |
| `FAAPI_SCHEMA=0` 或 `FAAPI_SCHEMA=false` | 强制关闭 |
| 未设置 + 开发环境 | 默认开启 |
| 未设置 + 生产环境 | 默认关闭 |

## 相关模块

- `@faapi/faapi`（buildRouteSchemas）— 生成路由 schema
