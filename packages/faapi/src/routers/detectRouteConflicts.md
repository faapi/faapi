# detectRouteConflicts

一句话概括：检测路由冲突，发现重复定义。

## 为什么需要

多个 handler.ts 可能导出相同路由（如 `api/user/login/handler.ts` 和 `api/auth/login/handler.ts` 都导出 GET 映射到 `/api/login`），需要在开发时检测并提示。

## 使用场景

- 开发模式启动时检测
- 帮助开发者发现配置错误

## 相关模块

- `routeTypes.ts` - 使用路由类型
- `createApp.ts` - 可选调用检测
