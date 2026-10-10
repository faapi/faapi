---
'@faapi/faapi': minor
---

新增 runHub 传输中枢（`createRunHub`）：交互式 run 与 HTTP 解耦 + 订阅式消费的官方原语——`start`（同键冲突抛 `RunConflictError`，`FaapiError` 子类 409）/ `subscribe`（同拍「注册+快照」，缓冲重放 + 实时接续无缺口无重复）/ `publishExternal`（轮外直播 seq=0 不进缓冲）/ `abort`（触发 `handle.signal`，接 LLM AbortSignal 链路）/ `finish` 即清。键与事件载荷泛型（K/E），缓冲上限、重放策略可配；可选持久化 SPI（`append`/`loadSince`）支持 `sinceCursor` 增量，未提供即纯内存（缺省零依赖）。事件 seq 每键严格单调跨 run 不清零（基座为键触碰时刻的毫秒时间戳，跨进程不碰撞，游标语义依赖）。append 失败为持久化旁路失败：留痕不杀直播主流程。语义契约见 `src/runhub/runHub.md`。
