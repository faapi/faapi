---
'@faapi/agent': minor
---

新增子代理 delta 冒泡（GAP-1）：流式父循环执行 sub-agent（`agent.<name>` tool call）时，嵌套循环的思考与产出增量实时冒泡到父流——多 agent 协作页面此前只能显示动作短语行，子代理长任务期间用户得不到过程反馈，排障只能事后开 tracing。

- `ReactLoopStreamChunk` 新增 `subagentDelta` chunk：`{ name: 'agent.<名>', depth, deltaContent?, deltaReasoning? }`（`depth` 与 `maxAgentDepth` 口径一致，根循环 = 1）；类型 `SubAgentDelta` / `SubAgentDeltaEmitter` 公开导出。冒泡顺序即实际输出顺序
- 机制：`await executeTool` 期间 async generator 挂起无法 yield——流式路径对每个 tool call 采用 fire-and-drain 泵（fire 执行 → generator 侧 drain 队列逐个 yield → 完成后 flush 剩余）；执行抛错时已 emit 的增量仍透出，错误走既有 tool 错误路径
- 父为流式时 `executeSubAgent` 让子循环也跑流式（此前固定非流式 `run()`，子循环没有流式增量可冒泡）；从子流 `done` / `traceEvent` 拼装结果，usage/turns 上卷与 `subagent_call` 嵌套 trace 结构不变
- 语义不变式：嵌套 `reasoning_content` 依旧不进 messages 历史与续跑源（仅透出）；非流式 `run()` 不受影响（结果一次性返回）；自定义 `run` 的 sub-agent 无结构化增量、不冒泡（与 usage 计 0 同口径）；中断 / `maxAgentDepth` / 历史剥离全部不回归
