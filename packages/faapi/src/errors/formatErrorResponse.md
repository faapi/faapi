# formatErrorResponse

一句话概括：将错误转换为统一的 JSON 响应，作为框架内置兜底。

## 为什么需要

所有错误需要转换为统一的 JSON 格式响应，包含 code、message、issues 等字段。
当全局错误中间件未捕获、或未配置错误中间件时，由本函数兜底生成响应。

## 使用场景

- 错误处理时格式化响应（兜底链最后一环）
- 统一错误响应结构

## 相关模块

- `httpErrors.ts` - 错误类
- `server/serverUtils.ts` - `buildErrorResponse` 调用此函数
- 全局错误中间件（业务侧在 `faapi.config.ts` 的 `middlewares` 中 `try/catch next()`）优先于此函数处理

