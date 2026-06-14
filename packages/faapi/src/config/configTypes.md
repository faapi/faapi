# configTypes

一句话概括：定义框架配置 FaapiConfig 的类型结构。

## 为什么需要

CLI 和 server 启动时需要统一的配置结构，包含根目录、app 目录、端口和路由模式等。集中定义确保 CLI 解析和 server 启动使用相同的配置格式。

## 使用场景

- CLI 参数解析后生成 FaapiConfig
- server 启动时读取 FaapiConfig
- 扩展点：responseFormat（统一响应格式）、errorFormat（错误格式）、lifecycle（onReady/onClose/onError）、extendContext（扩展 ctx 方法）

## 关键设计

- `lifecycle.onError(error, ctx)`：错误已被 errorFormat 处理为响应、响应发出后触发的副作用钩子（参考 Fastify onError 语义）。用于日志/告警/链路追踪，**不修改已生成的响应**。自身抛错被捕获并忽略。
- **错误处理兜底链**：handler 抛错 → 用户 `errorFormat(err, ctx)` 生成响应 → 若 errorFormat 抛错则框架内置 `formatErrorResponse(err)` 兜底 → 仍失败则最简 500 JSON 响应 → 响应发出后触发 `onError` 副作用。
- `extendContext(ctx)`：创建上下文后调用，用户可挂载自定义方法/属性到 ctx；配合 `declare module '@faapi/faapi'` 增强 FaapiContext 类型。
- `FaapiContextConfig`：空 interface，用户可通过声明合并增强 `ctx.config` 的类型。

## 相关模块

- `parseArgs.ts` - 解析 CLI 参数生成配置
- `startCommand.ts` - 使用配置启动 server
- `createContext.ts` - 调用 extendContext 扩展 ctx
