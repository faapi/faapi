# middlewareTypes

一句话概括：中间件核心类型定义,采用洋葱模型（单一 async 函数 `(ctx, next) => Promise<void | Response>`）

## 为什么需要

统一中间件接口,通过 `await next()` 衔接 handler 与后续中间件,支持前置拦截、后置处理、错误捕获、请求拦截等场景。

## 使用场景

所有中间件必须实现此接口。中间件为单一 async 函数,通过控制 `await next()` 的时机实现不同行为：

| 行为 | 时机 | 用途 |
|------|------|------|
| `await next()` 之前 | handler 执行前 | 日志、鉴权拦截 |
| `await next()` 之后 | handler 执行后 | 日志、响应修改 |
| 不调用 `next()` | 拦截请求 | 鉴权失败、限流 |
| `try/catch` 包裹 `next()` | 错误捕获 | 错误处理、日志 |

## 相关模块

- `invokeHandler.ts` - 调用中间件链
- `loadMiddlewares.ts` - 校验中间件项
- `cors.ts` - 实现中间件接口
- `logger.ts` - 实现中间件接口
