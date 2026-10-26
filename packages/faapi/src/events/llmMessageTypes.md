# llmMessageTypes（LLM 线格式消息规范类型）

一句话概括：`LLMMessage` / `LLMToolCall` 的规范类型定义——agent 循环的 LLM 线格式消息契约，主包持有。

## 为什么需要

`AgentInputEvent.messages`（[appEventBus](./appEventBus.md) 事件载荷）需要引用消息类型，而事件目录类型由主包持有（主包不能反向依赖 `@faapi/agent`，依赖方向是 agent → 主包 peer）。因此类型规范迁入主包（与 `LlmConfig` / `LlmComplete` 同款「主包持有规范、agent 实现并 re-export」先例，见 [injection/llmTypes](../injection/llmTypes.md)），`@faapi/agent` 的 `provider.ts` re-export 保持所有既有导入路径不变——业务方从 `@faapi/agent` 导入标注的用法不受影响（单一来源，无重复定义）。

字段拼写与 OpenAI 线格式一致（`tool_calls` / `tool_call_id`），provider 对 messages 恒等透传，消费方按 OpenAI 形状处理。

## 使用场景

- `AgentInputEvent.messages` 载荷类型（`agent:input` 事件改写面）
- `@faapi/agent` 的 `provider.ts` re-export（导入路径兼容层）
- 业务方在事件 handler 中读写消息历史时的类型标注

## 相关模块

- [appEventBus](./appEventBus.md)——事件载荷引用本类型
- `@faapi/agent` [provider](../../../agent/src/provider.md)——原定义处（现 re-export 主包）
