---
'@faapi/agent': minor
---

feat(agent)!: 子代理事件统一冒泡通道 subagentEvent

流式父循环的子代理中间事件冒泡收敛为单一统一通道：`ReactLoopStreamChunk.subagentEvent`（`SubAgentEvent` 判别联合，`type: 'delta' | 'tool_call' | 'tool_result'`）。子代理的 LLM 增量、tool 调用与结果（含其派发孙代理的调用）实时冒泡到父流，孙代理事件全链透传，单队列保序（冒泡顺序即子代理内实际发生顺序）。

**破坏面（公开类型重命名，运行时行为为原能力的超集）**：

- chunk 字段 `subagentDelta` 移除 → 改读 `subagentEvent`（原增量形态对应 `type: 'delta'`，字段 name/depth/deltaContent/deltaReasoning 不变）
- 导出 `SubAgentDelta` / `SubAgentDeltaEmitter` 移除 → 改用 `SubAgentEvent` / `SubAgentEventEmitter`（回调方法 `onSubAgentDelta` → `onSubAgentEvent`）
- 自定义 `ToolExecutor` 第三参类型同步更名

已按维护者决策随 7.x 线发布；台账见 HISTORY.md「已移除概念台账」。
