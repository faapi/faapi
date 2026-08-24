# formatErrorResponse

一句话概括：错误响应格式化的 re-export 入口，实现已移至 [response/responseFormatter.ts](../response/responseFormatter.ts)。

## 为什么需要

`formatErrorResponse` 原本在 errors/ 模块自己实现错误响应格式化，与 `ctx.fail()` 主动错误响应共享同一套 fail 函数的需求促成了集中化重构。

## 现状

本文件仅作为 re-export 入口：

```ts
export { formatErrorResponse } from '../response/responseFormatter';
```

保留此文件的目的：

1. errors/ 模块内部互引（httpErrors / FaapiError 等不直接依赖 responseFormatter）
2. 不破坏现有 import 路径（`serverUtils.ts` / 本文件的 test 等仍可从 `errors/formatErrorResponse` 导入）
3. 概念上 `formatErrorResponse` 处理 errors 类型的分发，留在 errors/ 入口合理

## 使用场景

- `serverUtils.buildErrorResponse(err, config)` 调用此函数（兜底链最后一环）
- 测试场景直接调用验证格式

## 相关模块

- [response/responseFormatter](../response/responseFormatter.md) —— 实现位置，集中所有响应格式逻辑
- [server/serverUtils](../server/serverUtils.md) —— `buildErrorResponse` 调用此函数，传 `ctx.config` 让业务方自定义 fail 函数生效
- [errors/httpErrors](./httpErrors.md) —— FaapiError 子类（`ValidationError` / `MethodNotAllowedError` / `PayloadTooLargeError` 等，由 `formatErrorResponse` 分发处理）
- 全局错误中间件（业务侧在 `faapi.config.ts` 的 `middlewares` 中 `try/catch next()`）优先于此函数处理
