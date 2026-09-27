---
"@faapi/faapi": minor
---

统一输入口径：raw 系原始字段 + 转换后值全链路一致

输入字段二分：`query`/`params`/`body` 恒为校验转换后的值，新增 `rawQuery`/`rawParams`/`rawBody` 恒为原始值（同名 ctx 字段 + handler 注入参数），在 ctx、目录/全局中间件、handler 注入所有访问点口径一致。

**行为变更（升级需排查）**：

1. `ctx.query`：`URLSearchParams` → 校验转换后对象（声明字段 coerce，未声明字段保留原始字符串；未声明 query 形参时保持原始对象）。原 `URLSearchParams` 移至 `ctx.rawQuery`——迁移：`ctx.query.get('x')` → `ctx.rawQuery.get('x')`。
2. `WsContext.query`：同上改为转换后对象，新增 `WsContext.rawParams`/`rawQuery`。
3. DELETE 声明 `body`/`form` 且空请求体：不再注入 undefined 跳过校验，与 POST 同路径返回 422（空请求体对声明了 body 的 handler 属客户端错误）。
4. DELETE 的 body 新增 form-urlencoded / multipart 支持（此前一律按 JSON 解析、form 请求体 400 INVALID_FORMAT）。
5. `resolveInputFromUrl` / `resolveBodyForQueryMethod`（内部 API）返回结构改为 `{ input, rawBody }`。

**新增**：

- `ctx.rawQuery`（URLSearchParams）/ `ctx.rawParams`（原始路径段）/ `ctx.rawBody`（请求体原始文本，Webhook HMAC 验签场景）+ 同名 handler 注入参数，无 schema、无校验、管线永不转换。
- `ctx.body` 挂载校验后的请求体：目录中间件首次可在 handler 之前读取请求体（与注入 body 同一对象）；GET/HEAD 恒 undefined。
- 路由匹配提前到中间件链之前：全局中间件 `await next()` 之前 `ctx.params`/`ctx.rawParams` 即为匹配的原始段（此前为空对象）；404/405 响应仍经过完整外层中间件链。
- WebSocket 握手接入声明即校验：handler.ts 导出 `WS` 且同文件声明 `export interface Query` / `export interface Params` 时生成 `WSQuery`/`WSParams` schema（coerce=true），握手校验转换，失败 422 拒绝握手；未声明约定透传原始字符串（不误伤）。
