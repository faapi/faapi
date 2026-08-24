# 响应处理

将 handler 返回值转为 HTTP Response，并写入 Node.js ServerResponse。

## 模块

| 模块 | 说明 |
| --- | --- |
| [toResponse.ts](./toResponse.ts) | 将 handler 返回值统一转换为 Response |
| [sendNodeResponse.ts](./sendNodeResponse.ts) | 将 Web Response 写入 Node.js ServerResponse |
| [responseFormatter.ts](./responseFormatter.ts) | 集中响应包装规则（ok/fail 函数），让 handler return 自动包裹、ctx.fail()、formatErrorResponse 三路径共享 |

## 转换规则

invokeHandler 在调用 `toResponse` 之前先经过 `wrapResult`（实现委托给 `responseFormatter.wrapOkResult`）自动包裹，包裹后的值再由 `toResponse` 转为 Response。

**wrapOkResult 包裹规则**（responseFormatter 层）：

| handler 返回值 | wrapOkResult 处理 |
| --- | --- |
| `Response` 对象 | 不包裹，原样透传 |
| 其他值（含 `null`/`undefined`） | 用 `config.response.ok`（默认 `(data) => ({ data })`）包裹 |

`null`/`undefined` 也会被包裹为 `{ data: null }` / `{ data: undefined }`（后者 JSON 序列化后为 `{}`）。如需返回 204 No Content，handler 应显式返回 Response 对象（如 `new Response(null, { status: 204 })`）。

**toResponse 转换规则**（底层，直接调用时）：

| 值类型 | 转换结果 |
| --- | --- |
| `Response` | 原样返回（合并 meta headers） |
| 普通对象/数组 | JSON.stringify，Content-Type: application/json |
| `string` | text/plain |
| `number`/`boolean` | text/plain，String(value) |
| `null`/`undefined` | 204 No Content |
| `Promise` | await 后再处理 |
| `ReadableStream`/`Buffer`/`Uint8Array` | 二进制 body |

> 注：经 invokeHandler 调用时，handler 返回值已先被 wrapResult 包裹（null/undefined → `{ data: null }`），不会走到 toResponse 的 204 分支。toResponse 的 null/undefined → 204 规则仅对直接调用 toResponse 的场景生效。

### 自动包裹（统一响应包装）

框架默认开启自动包裹：handler return 非 Response 的值时（含 `null`/`undefined`），用 `config.response.ok`（默认 `(data) => ({ data })`）包裹。

- `Response` 对象不包裹（`ctx.ok`/`ctx.fail`/`ctx.json` 等返回的 Response 原样透传）
- 其他值（含 `null`/`undefined`）用 ok 函数包裹

可通过 `config.response` 自定义包装结构（ok/fail），详见 [config/configTypes.md](../config/configTypes.md)。

`ctx.ok(data)` 显式包裹等价于 `return data`（框架自动包裹），两者响应一致。`ctx.fail({ status?, code?, message })` 返回错误 Response，status 和 code 均可独立省略（无推导关系）。

## SSE 流式响应

当 handler 调用 `ctx.sse()` 时，invokeHandler 优先使用 SSE Response（忽略 handler 返回值）。SSE Response 的 Content-Type 为 `text/event-stream`，不走 toResponse 的常规转换链。

详见 [runtime/sse.md](../runtime/sse.md)。

## meta 合并

如果传入了 ResponseMeta（来自 FaapiContext 的 setStatus/setHeader/setCookie），会合并到最终 Response 中：
- `meta.status` 覆盖默认状态码
- `meta.headers` 合并到响应头
- `meta.setCookies` 追加到 Set-Cookie 头

SSE Response 同样会合并 meta（通过 invokeHandler 的 mergeMeta），因此 `ctx.setStatus` / `ctx.setHeader` 在 SSE 场景下也生效。

## 相关模块

- [runtime](../runtime/README.md)：invokeHandler 调用 toResponse；SSE 支持见 runtime/sse.ts
- [server](../server/README.md)：调用 sendNodeResponse
