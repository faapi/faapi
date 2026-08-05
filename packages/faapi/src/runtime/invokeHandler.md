# invokeHandler

一句话概括：调用 handler 并转换返回值为 Response，提供洋葱模型调度（compose）、响应元数据合并（mergeMeta）与返回值自动包裹（wrapResult）。

## 为什么需要

调用用户定义的 handler，将返回值统一转换为 Web 标准 Response。
compose 将中间件链包装成 next 函数，供路由级中间件和全局中间件（如 CORS）复用同一套洋葱模型调度。
mergeMeta 在中间件返回 Response 时合并 ctx.setStatus/setHeader/setCookie 的设置。
wrapResult 在 toResponse 前自动包裹 handler 返回值，实现统一响应格式（`{ data }` / `{ error: { code, message } }`）。

## 使用场景

- 调用路由 handler
- 转换返回值为响应
- compose：调度中间件链（路由级 + 全局级如 CORS）
- mergeMeta：中间件拦截场景下保证 ctx 便捷方法生效
- wrapResult：自动包裹 handler 返回值（成功响应统一 `{ data }`）

## wrapResult 自动包裹

invokeHandler 在调用 `toResponse` 之前调用 `wrapResult` 自动包裹 handler 返回值（无中间件和有中间件两条路径都会调用）。

包裹规则：

| 返回值类型 | 处理 |
| --- | --- |
| `Response` 对象 | 不包裹，原样透传（`ctx.ok`/`ctx.fail`/`ctx.json`/`ctx.redirect` 等返回的 Response） |
| 其他值（含 `null`/`undefined`） | 用 `config.response.ok`（默认 `(data) => ({ data })`）包裹 |

`null`/`undefined` 也会被包裹为 `{ data: null }` / `{ data: undefined }`（后者 JSON 序列化后为 `{}`），不再返回 204 No Content。如需返回 204，handler 应显式返回 Response 对象（如 `new Response(null, { status: 204 })`）。

由于 `ctx.ok()` 返回的是 Response 对象，`wrapResult` 会原样透传，所以 handler 用 `return ctx.ok(data)` 或 `return data` 最终响应一致（都是 `ok(data)` 的结果），不会双重包裹。

```ts
// 以下两种写法等价（假设 response.ok 为默认实现）：
export function GET() {
  return { id: 1 };              // wrapResult 包裹 → { data: { id: 1 } }
}
export function GET2(ctx) {
  return ctx.ok({ id: 1 });      // ctx.ok 返回 Response，wrapResult 透传 → { data: { id: 1 } }
}

// 错误响应同理，ctx.fail 返回 Response 不被包裹：
export function GET3(ctx) {
  return ctx.fail({ status: 404, code: 'NOT_FOUND', message: '不存在' }); // → { error: { code: 'NOT_FOUND', message: '不存在' } }, 404
}
```

## 相关模块

- `toResponse.ts` - 转换响应
- `contextTypes.ts` - 上下文类型、ResponseMeta
- `createServer.ts` - 使用 compose 包裹全局中间件（CORS）与路由处理管线
