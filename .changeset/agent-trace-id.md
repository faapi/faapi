---
'@faapi/agent': minor
'@faapi/faapi': minor
---

@faapi/agent 新增层级追踪 ID（traceId）：每次 `agent.run()` / `agent.stream()` 自动生成 12 位十六进制段，sub-agent 派发链式续拼（父完整 ID + '.' + 新段），注入最终 system prompt 末尾（中性元数据措辞，指示 LLM 忽略）并在结果暴露（`result.traceId` / 流式 `done.traceId` / `trace.traceId`）——LLM 网关日志与业务日志按同一 ID 关联、按前缀聚合调用树。

- 默认开启；`config.agent.traceId: false` 整体关闭（不生成、不注入、结果无字段）
- `config.agent.traceIdTemplate` 自定义注入文案（须含 `{traceId}` 占位符，缺失抛 `AgentError`）
- `agent.run(input, { traceId: ctx.requestId })` 显式指定（优先级最高，全局关闭也生效）
- 配置字段定义在 `@faapi/faapi` 的 `AgentConfig`（`traceId` / `traceIdTemplate`），运行时语义在 `@faapi/agent`（详见其 traceId.md）
