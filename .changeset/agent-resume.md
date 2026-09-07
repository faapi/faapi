---
'@faapi/agent': minor
---

agent 子系统支持中断恢复（Resume）：`AgentAbortError` / `ReactLoopError` 新增 `messages` 属性携带断点/完整历史；`agent.run` / `agent.stream` 的 `input` 变为可选，新增 `options.messages` 从断点续跑（历史缺 system 时自动补齐 agent systemPrompt，非空 input 追加为多轮对话）。`AgentAbortError`/`ReactLoopError` 构造函数新增可选 `messages` 参数，向后兼容。
