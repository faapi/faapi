---
'@faapi/faapi': minor
---

`@faapi/agent` 流式收尾 chunk（`done`）新增 `messages` 字段——最终完整对话历史，与非流式 `ReactLoopResult.messages` 同源对齐。此前历史只从非流式返回值或异常路径（`ReactLoopError`/`AgentAbortError`）可得，流式消费方（长任务分段、挂起/恢复编排）拿不到断点状态：现在 run 正常收尾即从 done chunk 持久化历史，段间经 `run(undefined, { messages })` 续跑，无需制造异常。历史满足轮组原子性（assistant.toolCalls 与 tool 结果配对）可直接回传。
