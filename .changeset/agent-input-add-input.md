---
'@faapi/faapi': minor
'@faapi/agent': minor
---

`agent:input` 事件写面重构为「历史编辑窗口」（append-only 不可变账本）：

- **`addInput(text, index = 100)` 成为唯一写面**——补充输入文本片段，扇出结束后按 index 升序稳定排序（同 index 保持调用序）、`'\n\n'` 拼接，前置进**当轮输入消息**（当轮无新输入的工具轮/纯续跑轮为新增 user 消息），**落账进对话历史**：后续轮次、`result.messages` / `done.messages`、断点续跑链全部可见且不可变。多监听（通用名 + 专属名 + 同名多订阅）的片段合并为一条 user 消息。
- **`messages` 变为历史只读快照**（深冻结克隆）——任何写操作抛 `TypeError`；整体替换赋值抛迁移错误。旧的「改写仅作用本轮发送、不落历史」副本口径移除。
- **事务性**：任一订阅端抛错 → 暂存整批丢弃、历史零污染，错误照常走 run/stream 既有错误链。
- **迁移指引**：旧替换式写法 `e.messages = [...]` 改为逐段 `e.addInput(...)`（需要顺序时传 index，推荐留隙 10/20/30）；「每轮临时提示」场景改为每轮 `addInput`（片段落账后持续生效，变更文案 = 追加新版本）。

历史超限承接事件化（`agent:history-over-budget`）：

- **框架零内置裁剪**——`trimHistory` 自动截断与 `historyCompactor` 压缩策略位（`AgentRuntimeConfig.historyCompactor` 配置字段、`HistoryCompactor` / `HistoryCompactorInput` 导出、`historyCompaction` 模块）全部移除；`maxHistoryTokens` 保留但语义收敛为**超限阈值**（字符数/2 近似估算）。
- **新增 `agent:history-over-budget` / `agent:history-over-budget:<agentName>` 事件**：每轮估算超阈值时发射（载荷 `{ depth, estimatedTokens, budget, messages: 只读快照, ctx, replace }`），业务调 `replace(history)` 用压缩产物**整体替换循环历史**（落账：后续轮次 / result.messages / 续跑链全可见且不可变；多 handler 后调覆盖先调；不调 = 原样发送）。压缩后如同新对话，但 `agent:root-input` 不重触发；当轮至多发射一次，后续轮次重新估算、仍超限再发。
- **`replace` 产物校验**（框架强制）：非空 + 消息角色合法 + `assistant.tool_calls` 与 tool 结果配对完整（含孤立 tool 结果检测——与续跑历史同款约束），违反抛 `AgentError` 且替换不生效。
- **迁移指引**：`agentConfig.historyCompactor` 策略改为 `src/bootstrap.ts` 订阅 `agent:history-over-budget`（`e.replace(compacted)`）；未订阅时超限历史原样发送（provider 可能 400——长度控制是业务知识）。
