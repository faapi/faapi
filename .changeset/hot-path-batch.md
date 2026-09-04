---
'@faapi/faapi': patch
---

请求热路径优化批次（行为语义不变）：

- **URL 单次解析**：每请求只在 `toWebRequest` 内做一次 `new URL`，pathname/searchParams 由 ctx 与参数解析共享（原一次请求重复解析 3~4 次）；新增内部变体 `createContextFromUrl` / `resolveInputFromUrl`，公开 API 签名不变。
- **content-length 快速 413**：请求体带 `content-length` 且超过 `bodyLimit` 时在流读取前直接返回 413（chunked 无此头仍走流式限流）。
- **外层中间件链启动期组装**：CORS → helmet → logger → 全局中间件数组在 createServer 时构建一次，每请求不再重复 spread 重组。
- **dev 热路径同步 IO 短路**：`prodPathToSourcePath` 映射缓存（reloadRoutes 时清空），`loadRouteModule` 去掉冗余的每请求 `existsSync`——编译完成后稳态请求零 fs 访问。
