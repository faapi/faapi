---
'@faapi/faapi': minor
'@faapi/agent': minor
---

新增 tracing：单次 agent 调用的结构化 trace（含 LLM 调用、tool 调用、sub-agent 嵌套调用事件 + timing + token 用量）

## 变更说明

`agent.run()` / `agent.stream()` 默认开启 tracing（`enableTracing` 默认 true）。开启时返回值附加结构化调用明细：

- **非流式**：`ReactLoopResult.trace?: AgentTrace`（agentName + startedAt + durationMs + turns + usage + stopReason + content + events）
- **流式**：`ReactLoopStreamChunk.traceEvent?: AgentTraceEvent`（与 deltaContent / toolCall / toolResult / done 互斥,增量推送）

事件类型（discriminated union）：`llm_call`（每轮 LLM 调用）/ `tool_call`（常规 tool）/ `subagent_call`（sub-agent 调用,内嵌递归 trace）。

## 新增 API

`@faapi/agent` 导出：

- 类型：`AgentTrace` / `AgentTraceEvent` / `LlmCallEvent` / `ToolCallEvent` / `SubAgentCallEvent` / `TracingToolResult`
- 类型守卫：`isTracingToolResult(value)`
- `ReactLoopConfig.enableTracing?: boolean`（默认 true）
- `ReactLoopResult.trace?: AgentTrace`
- `ReactLoopStreamChunk.traceEvent?: AgentTraceEvent`
- `AgentRunOptions.enableTracing?: boolean`
- `AgentRuntimeConfig.enableTracing?: boolean`

`@faapi/faapi` 导出：

- `AgentConfig.enableTracing?: boolean`（全局默认,默认 true）

## 三层覆盖优先级

`AgentRunOptions.enableTracing` > agent 自身配置 > `config.agent.enableTracing`（默认 true）。

## sub-agent 嵌套 trace

`Agent.executeSubAgent` 在 `enableTracing=true` 时把 sub-agent 返回的 `result.trace` 包装为 `TracingToolResult`（`{ __trace: true, result, trace }`）返回给 reactLoop,reactLoop 通过 `isTracingToolResult` 识别后发出 `subagent_call` 事件,嵌入 sub-trace（递归结构,业务方可还原完整调用树）。

`enableTracing=false` 时 `executeSubAgent` 返回 `result.content`（与常规 tool 一致,零开销）。

## 性能开销

| 场景 | 开销 |
|------|------|
| `enableTracing=false`（opt-out 关闭） | 零——无新对象构造,无 timing 调用,与现状完全一致 |
| `enableTracing=true`（默认） | 每轮 1 次 `performance.now()` 配对（< 1μs）+ 每事件 ~100B 对象 + sub-agent 递归采集。100 轮估算 < 10KB trace + < 1ms |

## 业务方影响

- **默认开启**：业务方在生产高 QPS 端点显式 `agent.run(input, { enableTracing: false })` 或 `config.agent.enableTracing: false` 关闭以零开销运行
- **调试 / 开发面板 / tracing 端点**：用 `result.trace` 或流式 `chunk.traceEvent` 持久化到 DB / Jaeger / OpenTelemetry
- **sub-agent handler 导出 `run` 函数时无 trace**：业务方自己返回业务结果,不参与 reactLoop 的 tracing 采集——需 trace 时让 sub-agent 走默认 reactLoop（不导出 `run`）

## 未变更

- `reactLoop` / `reactLoopStream` 的循环逻辑、消息格式、tool 执行流程保持不变
- `AgentHandle` 接口签名不变（`run` / `stream` / `asTool`）
- `AgentConfig` 现有字段（`llms` / `defaultLlm` / `defaultAgent` / `maxTurns` / `maxAgentDepth`）保持不变
