# responseFormatter

一句话概括：集中所有响应格式规则，让 handler return 自动包裹、ctx.fail() 主动错误响应、formatErrorResponse 抛错兜底三条路径共享同一套 ok/fail 函数，确保响应格式在所有路径一致。

## 为什么需要

响应格式原本散落在三处：

- [runtime/invokeHandler.ts](../runtime/invokeHandler.ts) 的 `wrapResult` —— handler return 值的自动包裹（成功路径）
- [runtime/createContext.ts](../runtime/createContext.ts) 的 `ctx.ok` / `ctx.fail` —— 显式构造 Response
- [errors/formatErrorResponse.ts](../errors/formatErrorResponse.ts) —— handler 抛错的兜底

每处都各自定义默认 ok/fail 函数（`((data) => ({ data }))`），且 `formatErrorResponse` 不读 `config.response.fail`——业务方自定义 fail 函数只对「主动错误响应」生效，对「抛错兜底」无效，导致两条错误路径的响应格式可能漂移。

本模块集中所有响应格式逻辑：

| 函数 | 用途 | 调用方 |
| --- | --- | --- |
| `defaultOk` / `defaultFail` | 默认包装函数 | `resolveOkFn` / `resolveFailFn` 的兜底 |
| `resolveOkFn(config)` / `resolveFailFn(config)` | 解析业务方自定义 ?? 框架默认 | wrapOkResult / formatFailResponse / formatErrorResponse |
| `jsonOk(body, status, extraHeaders?)` | 构造 JSON Response（不包外层，原样序列化） | ctx.ok / ctx.json / ctx.fail / formatFailResponse / formatErrorResponse |
| `wrapOkResult(result, config)` | handler return 自动包裹 | invokeHandler.wrapResult |
| `formatFailResponse(options, config)` | 主动错误响应 | ctx.fail |
| `formatErrorResponse(error, config?)` | 抛错兜底响应 | serverUtils.buildErrorResponse |

## 三条路径共享同一套函数

```
handler `return ctx.fail({...})`         → formatFailResponse        → Response（主动错误）
handler `return data` 或非 Response 值    → wrapOkResult + toResponse → 自动 `{ data }` 包装（成功路径）
handler `throw err`                       → formatErrorResponse      → 走 fail 函数包装
```

业务方在 `faapi.config.ts` 配置 `response.ok` / `response.fail`，三条路径自动一致生效：

- `response.ok` 影响 `wrapOkResult`（成功路径自动包裹）
- `response.fail` 同时影响 `formatFailResponse`（主动错误）和 `formatErrorResponse`（抛错兜底）

## formatErrorResponse 的 FaapiError 分发

`formatErrorResponse` 按错误子类分发，每个分支调 `failFn({ status, code, message })` 包装：

| 错误类型 | 状态码 | 额外字段 |
| --- | --- | --- |
| `ValidationError` | 400/422（按 issue.code 推导） | 附加 `issues` 数组 |
| `MethodNotAllowedError` | 405 | 附加 `Allow` header |
| `PayloadTooLargeError` | 413 | — |
| 其他 `FaapiError` 子类 | 用 `error.statusCode` | — |
| 未知 Error / 非 Error | 500 | code 固定 `INTERNAL_ERROR` |

> 业务方自定义 Error 子类（非 FaapiError）会被归到 500 `INTERNAL_ERROR`，丢失业务错误码——若需保留业务码，应继承 `FaapiError` 或在全局中间件 `try/catch next()` 后用 `ctx.fail()` 显式返回。

## ValidationError 的 issues 字段处理

`formatErrorResponse` 在 ValidationError 分支特殊处理 `issues` 字段：

1. 调 `failFn({ status, code, message })` 得到 body（默认 `{ error: { message, code } }`）
2. 在 body 的 `error` 对象上扩展 `issues` 字段

如果业务方自定义 fail 函数返回的 body 没有 `error` 字段（如直接返回 `{ myCode, msg }`），`issues` 会加到顶层 bodyObj 上——这属于边缘情况，业务方自定义 fail 应保持返回 `{ error: {...} }` 结构。

## 使用场景

- handler `return data` —— 自动包裹（wrapOkResult）
- handler `return ctx.ok(data)` —— 显式包裹（wrapOkResult + jsonOk）
- handler `return ctx.fail({...})` —— 主动错误（formatFailResponse）
- handler `throw err` —— 抛错兜底（formatErrorResponse）

## 相关模块

- [toResponse](./toResponse.md) —— 把 wrapOkResult 包裹后的值（任意类型）转为 Response
- [errors/httpErrors](../errors/httpErrors.md) —— FaapiError 子类（ValidationError / MethodNotAllowedError / PayloadTooLargeError）
- [errors/formatErrorResponse](../errors/formatErrorResponse.md) —— re-export 入口，便于 errors 模块内部互引
- [runtime/invokeHandler](../runtime/invokeHandler.md) —— 调 wrapOkResult
- [runtime/createContext](../runtime/createContext.md) —— ctx.ok / ctx.fail 调 wrapOkResult / formatFailResponse
- [server/serverUtils](../server/serverUtils.md) —— buildErrorResponse 调 formatErrorResponse，传 ctx.config
