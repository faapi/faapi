# invokeHandler

一句话概括：调用 handler 并转换返回值为 Response，提供洋葱模型调度（compose）与响应元数据合并（mergeMeta）。

## 为什么需要

调用用户定义的 handler，将返回值统一转换为 Web 标准 Response。
compose 将中间件链包装成 next 函数，供路由级中间件和全局中间件（如 CORS）复用同一套洋葱模型调度。
mergeMeta 在中间件返回 Response 时合并 ctx.setStatus/setHeader/setCookie 的设置。

## 使用场景

- 调用路由 handler
- 转换返回值为响应
- compose：调度中间件链（路由级 + 全局级如 CORS）
- mergeMeta：中间件拦截场景下保证 ctx 便捷方法生效

## 相关模块

- `toResponse.ts` - 转换响应
- `contextTypes.ts` - 上下文类型、ResponseMeta
- `createServer.ts` - 使用 compose 包裹全局中间件（CORS）与路由处理管线
