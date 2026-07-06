# serverUtils

一句话概括：服务器层工具函数——`nodeHttpToWebHeaders`（Node.js IncomingMessage headers → Web Headers）+ `buildErrorResponse`（错误兜底响应链）。

## 为什么需要

faapi 的请求处理基于 Web 标准 `Request`/`Response`，但 Node.js HTTP server 原生使用 `IncomingMessage`/`ServerResponse`。`createServer`（HTTP 请求）和 `handleWsUpgrade`（WS 握手）都需要把 Node headers 转为 Web Headers 构造 `Request`。

错误处理需要统一兜底：handler 或中间件抛错后，必须保证返回一个 `Response` 给客户端，不能让进程崩溃。`buildErrorResponse` 实现兜底链确保任何情况下都返回 `Response`。

## 使用场景

- `createServer` 处理 HTTP 请求时调 `nodeHttpToWebHeaders` 转 headers；handler 抛错时调 `buildErrorResponse` 生成错误响应
- `handleWsUpgrade` 处理 WS 握手时调 `nodeHttpToWebHeaders` 转 headers；中间件抛错且未升级时调 `buildErrorResponse` 生成错误响应写回 socket

## API

### nodeHttpToWebHeaders

```ts
function nodeHttpToWebHeaders(req: IncomingMessage): Headers
```

遍历 `req.headers`，跳过 `undefined` 值；数组型值（如 `set-cookie`）用 `append` 逐个追加，标量值用 `set`。

### buildErrorResponse

```ts
function buildErrorResponse(err: unknown): Response
```

兜底链：

1. 调用 `formatErrorResponse`（内置兜底）生成响应
2. 内置兜底抛错 → 返回最简 500 JSON `{ error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } }`

> 业务方如需自定义错误响应,在全局中间件中 `try/catch next()` 后 `return ctx.json(...)` 拦截,优先于此函数。

`buildErrorResponse` 自身永不抛错——所有 try/catch 都有兜底，确保调用方总能拿到 `Response`。

## 相关模块

- `createServer.ts` - HTTP 请求处理，调用两个函数
- `handleWsUpgrade.ts` - WS 握手处理，调用两个函数
- `formatErrorResponse.ts`（errors）- 内置错误响应格式化，作为 `buildErrorResponse` 的兜底
