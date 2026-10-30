---
"@faapi/agent": minor
"@faapi/faapi": minor
---

下线 traceId 层级追踪 ID 功能，`agent.run` / `agent.stream` 不再向 system 消息注入 `[trace] trace_id=…` 块。

- 删除 `config.agent.traceId` / `config.agent.traceIdTemplate` 配置字段、`AgentRunOptions.traceId` 调用选项、`ReactLoopResult.traceId` / 流式 `done.traceId` / `AgentTrace.traceId` 结果字段，以及 `@faapi/agent` 的 `traceId` 内部模块
- sub-agent 派发不再链式续拼 ID；system 消息只含业务提示词（模板渲染 → `agent:system-prompt` 装饰 → 派发上下文块），框架不再注入任何元数据
- 存量项目升级：删除 `faapi.config.ts` agent 块中的 `traceId` / `traceIdTemplate`，以及调用处 `run(input, { traceId })` / `stream(input, { traceId })` 的传参（残留传参在类型层报错）；需要跨系统关联键的业务自行经 provider 请求头 / 日志字段传递。结构化调用明细仍由 `enableTracing` 承担
