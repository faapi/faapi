---
'@faapi/faapi': minor
---

feat: `app.inject()` 返回值新增 `raw` 字段——同进程取数类型保真

Next.js RSC 经 `getApp() + app.inject()` 同进程取数时，handler 返回值此前经 JSON 序列化往返（wrapResult 包裹 → toResponse 序列化 → inject 侧 JSON.parse），Date 等富类型丢失为 ISO 字符串，与 ORM 推断类型（如 `Novel.updatedAt: Date`）不符。

现在 `InjectResponse` 新增 `raw?: unknown`：当且仅当响应体由 handler 数据返回值自动包裹产生时，`raw` 为 handler 原始返回值（包裹/序列化之前），富类型不丢；`body` 保持 HTTP 语义（JSON 反序列化结果）不变，两者并存自选。handler 返回 `ctx.ok()`/`ctx.fail()` 等 Response 形态、抛错、中间件拦截、SSE、404/405/校验失败时 `raw` 为 `undefined`——快路径判断用 `res.raw !== undefined`。

对真实 HTTP 请求路径零行为变化（仅请求链路上两次属性赋值）。用法与捕获语义详见 `packages/faapi/src/cli/createAppCore.md`「inject 的 raw 字段」节。
