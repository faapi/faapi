---
'@faapi/agent': major
---

**BREAKING**：`ReactLoopResult.usage` / `turns`（流式 `done.usage` / `done.turns`）语义由「主循环用量」升级为「整树口径」——`usage` 为本次 run 全部 `llm_call` usage 之和（含全部层级 sub-agent 循环，多层递归逐层上卷），`turns` 同口径聚合（主循环轮数 + 全部 sub-agent 循环轮数）。`maxTurns` 循环控制与 trace 事件 `turn` 序号不受影响，仍为主循环口径；自定义 `run` 的 sub-agent 无结构化用量、计 0。tracing 关闭时上卷照常生效（用量台账不依赖 tracing）。按主循环口径消费 `usage` 的业务方需调整落库口径。机制：`Agent.executeSubAgent` 把子循环结果统一包装为新增的 `SubAgentToolResult`（`{ __subAgent, result, usage?, turns?, trace? }`），reactLoop 识别后上卷再剥壳回传 LLM；旧 `TracingToolResult` 仍兼容识别（仅发 `subagent_call` 事件、不上卷用量），已标 `@deprecated`。
