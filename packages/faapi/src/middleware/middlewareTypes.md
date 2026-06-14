# middlewareTypes

一句话概括：中间件核心类型定义，包含 before/resolve/after/error 四个钩子

## 为什么需要

统一中间件接口，支持前置拦截、参数注入、后置处理、错误处理

## 使用场景

所有中间件必须实现此接口；resolve 按需执行（只执行 handler 参数名匹配的 resolve）

## 相关模块

- `invokeHandler.ts` - 调用中间件钩子
- `loadMiddlewares.ts` - 校验中间件项
- `cors.ts` - 实现中间件接口
- `logger.ts` - 实现中间件接口
