# etag

一句话概括：内建 ETag/304 协商——为 GET/HEAD 响应生成弱 ETag，`If-None-Match` 命中时返回 304。

## 为什么需要

幂等 GET 是 API 缓存收益最大的方法（Express/Fastify 均内建或官方提供 ETag 支持）。
此前 faapi 只有 `ctx.setETag` 写头（handler 手动），框架既不生成也不协商，条件请求
能力完全缺位——客户端每次都拿全量 200 响应。

## 使用场景

- `faapi.config.ts` 中 `etag: true` 启用（默认关闭，opt-in）
- handler 显式 `ctx.setETag()` 时不覆盖——handler 控制优先

## 协商语义

- **生成**：GET/HEAD 2xx 响应，body 为可缓冲文本（跳过 `text/event-stream`），
  SHA-1 指纹生成**弱 ETag** `W/"<hash>"`——弱校验器允许压缩等表示差异下的 304
  （与 compression 中间件配合正确）
- **协商**：请求携带 `If-None-Match` 时按 RFC 7232 弱比较（忽略 `W/` 前缀）与
  生成值比对，命中列表中任一项或 `*` → 返回 304（无 body，携带 ETag 头）
- **跳过条件**：非 GET/HEAD、非 2xx、响应已带 `ETag`、`text/event-stream`、无 body
- **中间件位置**：compression 内层——先算 ETag/304 再压缩，304 无 body 压缩自动跳过

## 相关模块

- `compression.ts` - 外层配合（弱 ETag + 压缩表示 = 正确的弱校验语义）
- `../server/createServer.ts` - 中间件链组装
- `../config/configTypes.ts` - `etag?: EtagOptions | boolean` 配置面
