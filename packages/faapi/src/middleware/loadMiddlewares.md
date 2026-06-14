# loadMiddlewares

一句话概括：加载 middlewares.ts 文件并校验中间件项

## 为什么需要

构建时需要从文件系统加载中间件定义

## 使用场景

scanRoutes 时加载就近 middlewares.ts

## 相关模块

- `middlewareTypes.ts` - 校验中间件项类型
- `scanRoutes.ts` - 扫描路由时调用加载
