---
'@faapi/faapi': minor
---

`request:error` 事件收窄为仅服务端故障（5xx）发射：已按预期处理的 4xx（404 路由未找到、405 方法不允许、400/422 校验失败、业务抛出的 4xx FaapiError）不再发射——观察改由请求日志承接（4xx → warn，fields 含 requestId/method/path/status/durationMs）。

**为什么**：4xx 是客户端侧的预期结果，之前全部发射会迫使每个订阅端自行按状态码过滤；漏滤时扫描器对 `/api/.env` 之类路径的每次探测都会在订阅端产生一条带全栈的 ERROR，污染告警。新口径对齐业界默认（Fastify 4xx 记 info / Koa 跳过 404 / NestJS 不记 HttpException），未分级、无条件记录每条事件的订阅端升级后不再产生 4xx 误报。

**迁移**：依赖 `request:error` 观察 4xx 的订阅端改用请求日志（4xx → warn）或全局中间件自行采集；5xx 观察行为不变。SSE 流开始后的异常中断仍无条件发射（不按状态码门控）。
