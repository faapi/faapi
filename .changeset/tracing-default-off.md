---
'@faapi/agent': minor
---

tracing 默认值从开启改为关闭（opt-in）——`enableTracing` 不再默认 `true`，不开启时 `agent.run()` / `agent.stream()` 返回的 `result.trace` / `chunk.traceEvent` 为 `undefined`，零开销运行。

tracing 采集每轮 LLM 消息快照与 tool 明细，有真实内存/CPU 开销，此前所有不知情的用户都在隐性支付这笔成本。需要观测的端点显式开启：`config.agent.enableTracing: true`（全局）或 `agent.run(input, { enableTracing: true })`（单次调用）。
