# compression

一句话概括：内建响应压缩——按 `Accept-Encoding` 协商 gzip / deflate / br，压缩 handler 返回的 JSON / 文本响应。

## 为什么需要

JSON API 是 faapi 的主打场景，JSON 响应压缩后体积通常缩小 5-10 倍，直接降低带宽与
TTFB。Fastify（内建）与 Express（compression 中间件）、Hono（compress）均提供该能力，
缺失会被首轮选型筛掉。

## 使用场景

- `faapi.config.ts` 中 `compression: true` 或 `compression: { threshold: 2048 }` 启用
- 默认**关闭**（opt-in）：与 helmet 的显式启用语义一致，零配置项目行为不变

## 压缩语义

- **协商**：解析请求 `Accept-Encoding`（含 `q` 值，`q=0` 视为不接受），按 br > gzip >
  deflate 的服务器偏好选择；客户端不接受任何压缩时透传
- **Vary: Accept-Encoding** 无条件附加（响应内容随该头变化，无论本响应是否压缩——
  CDN/浏览器按 URL 缓存时不加 Vary 会造成编码错配的缓存污染）
- **跳过条件**（透传原响应，仅补 Vary）：
  - 响应无 body（204/304 等）
  - 已有 `Content-Encoding`（上游已压缩）
  - `Cache-Control: no-transform`
  - Content-Type 不可压缩（白名单：`application/json`、`text/*`、`application/javascript`、
    `image/svg+xml`；`text/event-stream` 被排除——流式语义不应缓冲）
  - body 小于 `threshold`（默认 1024 字节，小 payload 压缩反而变大）
- **实现**：缓冲 body（toResponse 产出的 JSON body 本就是字符串）→ zlib 异步压缩 →
  构造新 Response 替换返回。压缩中间件位于链最外层（CORS 之前），包住完整中间件链

## 相关模块

- `helmet.ts` - 同为"显式启用的内建中间件"先例
- `../server/createServer.ts` - 中间件链组装（compression → CORS → helmet → logger → 全局）
- `../config/configTypes.ts` - `compression?: CompressionOptions | boolean` 配置面
