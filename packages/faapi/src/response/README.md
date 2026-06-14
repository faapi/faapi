# 响应处理

将 handler 返回值转为 HTTP Response，并写入 Node.js ServerResponse。

## 模块

| 模块 | 说明 |
| --- | --- |
| [toResponse.ts](./toResponse.ts) | 将 handler 返回值统一转换为 Response |
| [sendNodeResponse.ts](./sendNodeResponse.ts) | 将 Web Response 写入 Node.js ServerResponse |

## 转换规则

| 返回值类型 | 转换结果 |
| --- | --- |
| `Response` | 原样透传（合并 meta headers） |
| 普通对象/数组 | JSON，Content-Type: application/json，200 |
| `string` | text/plain，200 |
| `number`/`boolean` | text/plain，String(value)，200 |
| `null`/`undefined` | 204 No Content |
| `Promise` | await 后再处理 |
| `ctx.sse()` 已调用 | 使用 SSE Response（text/event-stream），handler 返回值被忽略 |

## SSE 流式响应

当 handler 调用 `ctx.sse()` 时，invokeHandler 优先使用 SSE Response（忽略 handler 返回值）。SSE Response 的 Content-Type 为 `text/event-stream`，不走 toResponse 的常规转换链。

详见 [runtime/sse.md](../runtime/sse.md)。

**与 responseFormat 的关系**：responseFormat 只对 `application/json` 响应生效，SSE 是 `text/event-stream`，天然跳过，不会被包装。

## meta 合并

如果传入了 ResponseMeta（来自 FaapiContext 的 setStatus/setHeader/setCookie），会合并到最终 Response 中：
- `meta.status` 覆盖默认状态码
- `meta.headers` 合并到响应头
- `meta.setCookies` 追加到 Set-Cookie 头

SSE Response 同样会合并 meta（通过 invokeHandler 的 mergeMeta），因此 `ctx.setStatus` / `ctx.setHeader` 在 SSE 场景下也生效。

## 相关模块

- [runtime](../runtime/README.md)：invokeHandler 调用 toResponse；SSE 支持见 runtime/sse.ts
- [server](../server/README.md)：调用 sendNodeResponse
