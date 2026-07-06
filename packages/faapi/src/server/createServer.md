# createServer

一句话概括：创建 HTTP 服务器并处理请求分发。

## 为什么需要

将路由系统与 Node.js HTTP 服务器结合，处理请求分发、模块加载、参数校验、响应发送的完整链路。

## 使用场景

- 启动 HTTP 服务
- 请求分发到对应 handler
- 错误处理和响应发送
- CORS 作为标准中间件走洋葱模型（preflight 拦截、非 preflight 附加头后放行）
- onError 钩子：错误响应发出后触发，用于副作用（日志/告警），不修改已发出的响应（参考 Fastify onError 语义）
- 错误兜底链：全局错误中间件 try/catch 未拦截 → 内置 formatErrorResponse 兜底 → 仍失败则最简 500 JSON

## 相关模块

- `matchRoute.ts` - 路由匹配
- `loadRouteModule.ts` - 加载路由模块
- `resolveInput.ts` - 解析输入
- `invokeHandler.ts` - 调用 handler、导出 compose/mergeMeta 用于全局中间件调度
