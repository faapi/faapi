# loadRouteModule

一句话概括：动态加载路由模块并提取 handler。

## 为什么需要

路由文件需要动态 import，提取对应的 handler 函数，校验导出是否合法。

## 使用场景

- 请求到达时加载路由模块
- 提取 GET/POST 等 handler
- 校验模块导出合法性

## 相关模块

- `resolveExports.ts` - 提取导出
- `validateRouteModule.ts` - 校验模块
