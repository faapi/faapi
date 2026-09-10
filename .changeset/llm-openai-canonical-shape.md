---
'@faapi/faapi': major
---

**BREAKING**：`@faapi/agent` 的 LLM 接口规范形迁移为 OpenAI chat completions 形状，不再使用自创拼写（业务方反馈：观测/存储/展示等消费方被迫维护框架格式 ↔ OpenAI 格式双兼容层）。变更明细：

- `LLMMessage`：`toolCalls` → `tool_calls`、`toolCallId` → `tool_call_id`（与 OpenAI 线格式一致）
- `LLMToolCall`：扁平 `{ id, name, arguments: object }` → OpenAI 形状 `{ id, type: 'function', function: { name, arguments: string } }`——`arguments` 保持线格式 JSON **字符串**，解析边界收敛在 reactLoop（tool 执行函数 / authHooks / trace 事件拿到的仍是已 parse 对象）
- `LLMToolDefinition`：`{ name, description?, input }` → `{ type: 'function', function: { name, description?, parameters? } }`；`filterTools` 钩子收到的 tools 同步为此形状（按 `tool.function.name` 过滤）
- `LLMUsage`：`promptTokens`/`completionTokens`/`totalTokens` → `prompt_tokens`/`completion_tokens`/`total_tokens`
- OpenAI provider 请求侧（messages/tools）退化为**恒等透传**，assistant 消息原样进出，无重拼写；非 OpenAI provider 由各自适配器做"OpenAI → 该家"翻译
- 保持不变：`LLMStopReason`（词表本就与 `finish_reason` 一致）、`LLMStreamChunk`/`ReactLoopStreamChunk`（provider/reactLoop 内部流抽象，非线格式）、authHooks 的 `name`/`args` 入参（已 parse）

**存量数据迁移**：经 `AgentAbortError.messages` / `ReactLoopError.messages` / `result.messages` 持久化的对话历史（中断恢复/多轮续跑）为旧形状，升级后回传续跑需先转换（`toolCalls`→`tool_calls`、`toolCallId`→`tool_call_id`、tool call 参数对象→JSON 字符串、`{id,name,arguments}`→`{id,type:'function',function:{name,arguments}}`）。
