# constants

一句话概括：定义 HTTP 方法常量集合和类型守卫函数。

## 为什么需要

faapi 使用 `handler.ts` 文件导出 HTTP 方法名（如 `GET`、`POST`）。需要一个统一的常量定义，用于模块导出校验和路由生成，避免各模块重复定义或硬编码方法名。

## 使用场景

- 模块导出校验：检查 handler.ts 导出名是否合法
- 路由清单生成：为 RouteRecord 提供 HttpMethod 类型

## 相关模块

- `parseRouteFile.ts` - 使用 `isHttpMethod` 判断文件名
- `validateRouteModule.ts` - 使用 `isHttpMethod` 校验导出名
- `routeTypes.ts` - 使用 `HttpMethod` 类型
