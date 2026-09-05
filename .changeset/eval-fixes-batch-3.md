---
'@faapi/faapi': minor
---

框架评估修复批次 3：响应压缩、ETag/304 协商与 dev schema 后台预生成。

- **响应压缩（`config.compression`，默认关闭）**：按 `Accept-Encoding` 协商 br > gzip > deflate（含 q 值与 `*` 通配），压缩 JSON/文本响应；SSE/流式、已压缩、`no-transform`、低于 threshold（默认 1024 字节）的响应自动跳过；无条件补 `Vary: Accept-Encoding`（与 CORS 的 `Vary: Origin` 合并存放）。JSON API 响应体积通常缩小 5-10 倍
- **ETag/304 条件请求协商（`config.etag`，默认关闭）**：GET/HEAD 2xx 响应自动生成弱 ETag（SHA-1），`If-None-Match` 弱比较命中返回 304。弱校验器与压缩正确配合（ETag 基于未压缩表示，304 无 body 时压缩自动跳过）；handler 显式 `ctx.setETag()` 时不覆盖。此前框架只有 `setETag` 写头，既不生成也不协商，条件请求能力缺位
- **dev schema 后台预生成**：watcher 热替换后按需模式此前只删 zod.js 不重建，每次保存后所有路由的首个请求都要在请求路径上同步付全项目 Program 创建 + schema 生成的代价（p99 尖刺）。现在 reload 后台批量预生成（不阻塞 reload 与请求），请求路径的按需生成（mtime 缓存 + in-flight mutex + 原子写）兜底协同
