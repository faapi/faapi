# trace

一句话概括：单次 `agent.run()` / `agent.stream()` 的结构化调用明细——按轮次组织 LLM 调用、tool 调用、sub-agent 嵌套调用事件,含 timing 与 token 用量,默认关闭（opt-in 开启,不开启零开销）。

## 为什么需要

[reactLoop](./reactLoop.md) 现有的 `ReactLoopResult.messages` 是**扁平 LLM 消息数组**（供下次调用作为上下文传入）,但有三个场景无法满足：

- **调试 / 可观测**：业务方想看「agent 跑了几轮 / 每轮 LLM 调了多久 / 哪个 tool 卡了 / sub-agent 嵌套调用链路」——`messages` 不含 timing,sub-agent 调用与常规 tool 调用在 messages 里都是 `tool` role 消息,无法区分
- **admin 面板 / tracing 端点**：业务方要把单次 agent 调用的明细结构化序列化展示,需要按轮次分组的事件流,而非扁平消息
- **重放 / 评估**：业务方想单独重放某轮 LLM 调用（换 model / 改 systemPrompt 重跑）,需要该轮的 input 快照

`trace` 在 `ReactLoopResult` / `ReactLoopStreamChunk` 上附加 `trace` / `traceEvent` 字段,提供按轮次结构化的事件流,与 `messages` 互补不重复。

## 使用场景

- **调试单个 agent 调用**：`agent.run(input, { enableTracing: true })` 拿 `result.trace`,本地日志 / 开发面板展示调用树
- **生产 tracing 端点**：业务方在 `/api/agent-trace` 路由开 tracing,把 trace 持久化到 DB / tracing 系统（Jaeger / OpenTelemetry）
- **流式前端展示**：`agent.stream(input, { enableTracing: true })` 通过 SSE 推送 `traceEvent`,前端实时展示每轮 LLM 调用与 tool 执行进度
- **sub-agent 嵌套调试**：父 agent 调 sub-agent 时,sub-agent 的 trace 嵌入父 trace 的 `subagent_call` 事件（递归结构）,业务方可还原完整调用树

## 设计

### 核心类型

| 类型 | 说明 |
| --- | --- |
| `AgentTrace` | 单次 agent.run() 的完整明细（agentName + startedAt + durationMs + turns + usage + stopReason + content + events）；`turns` / `usage` 为整树口径（与 `ReactLoopResult` 同值，含全部 sub-agent 循环） |
| `AgentTraceEvent` | discriminated union,按 `type` 区分：`llm_call` / `tool_call` / `subagent_call`；事件 `turn` 序号是主循环口径（1..N 连续，不含 sub-agent 内部轮） |
| `SubAgentToolResult` | sub-agent tool 的结构化返回值（`{ __subAgent: true, result, usage?, turns?, trace? }`），reactLoop 据此上卷用量、发 `subagent_call` 事件（`trace` 存在时） |
| `TracingToolResult` | 旧版 sub-agent 返回值（`{ __trace: true, result, trace }`，无用量字段）——reactLoop 仍兼容识别（仅发事件、不上卷用量），新代码用 `SubAgentToolResult` |

### 触发机制：opt-in

- **默认关闭**（`enableTracing` 默认 `false`——opt-in,不开启零开销）,tracing 采集每轮 LLM 消息快照与 tool 明细有真实内存/CPU 开销,需要观测的端点显式开启：`config.agent.enableTracing: true`（全局）或 `agent.run(input, { enableTracing: true })`（单次）
- 三层覆盖优先级：`AgentRunOptions.enableTracing` > `Agent` 实例配置 > `config.agent.enableTracing`（默认 false）

### 暴露方式

- **非流式**：`ReactLoopResult.trace?: AgentTrace`（`enableTracing=true` 时填充）
- **流式**：`ReactLoopStreamChunk.traceEvent?: AgentTraceEvent`（与 deltaContent / toolCall / toolResult / done 互斥,一个 chunk 至多一个字段）
- **AgentHandle**：`agent.run(input, options?)` / `agent.stream(input, options?)` 新增 `options.enableTracing`

### 事件序列示例

一次 2 轮 agent.run()（第 1 轮调 1 个常规 tool,第 2 轮调 1 个 sub-agent）：

```
llm_call(turn=1, model='gpt-4o', inputMessages=[system+user], response={tool_calls:[search]}, usage={...})
tool_call(turn=1, name='search', args={q:'foo'}, result='...', durationMs=120)

并行 tool（同轮多个 tool_call）的 `durationMs` 各自独立——结束时间在各自的
执行闭包内采集,只含自身执行耗时,不包含等待同轮其他 tool 的时间
llm_call(turn=2, model='gpt-4o', inputMessages=[...+assistant+tool], response={tool_calls:[agent.translator]}, usage={...})
subagent_call(turn=2, agentName='translator', input='...', trace={AgentTrace（递归）}, durationMs=850)
done(content='最终答案', turns=2, stopReason='stop', usage={...})
```

### `llm_call.inputMessages` 存储策略

存该轮消息数组的**浅拷贝快照**（数组新对象,消息对象引用共享）：

- 便于单独重放某轮 LLM 调用（换 model / 改 systemPrompt 重跑）
- 内存开销可控（消息对象不复制,只新建外层数组）
- 与 `messages` 的关系：拼接所有 `llm_call.inputMessages` 的最后一个快照等价于 `result.messages`

### `llm_call.response` 与 thinking（`reasoning_content`）

`response` 记录该轮 LLM 的**原始** assistant 消息——thinking 模型（DeepSeek-R1 / Qwen-thinking 等）返回的 `reasoning_content` **保留在 trace 中**：观测/调试需要完整的原始 LLM 返回,推理内容是定位"模型为什么这么答"的关键依据。

这与对话历史的策略互补：reactLoop push 进 `messages`（发给 LLM / 持久化 / 续跑源）的 assistant 消息**剥离** `reasoning_content`（DeepSeek 多轮回传推理内容直接 400,详见 [reactLoop.md](./reactLoop.md) thinking 章节）——trace 是唯一保留推理内容的完整快照。流式路径的 trace response 同样带 `reasoning_content`（该轮累积的推理内容）。

## sub-agent 嵌套 trace

reactLoop 只调 `executeTool(name, args)`,**不知道某个 tool 是常规 tool 还是 sub-agent**。识别机制：

### SubAgentToolResult 与旧 TracingToolResult

`ToolExecutor` 返回值扩展为联合类型：

```ts
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown | SubAgentToolResult>;

export interface SubAgentToolResult {
  __subAgent: true;    // 标记字段
  result: unknown;     // 子代理最终 content（剥壳后作为 tool 消息回传 LLM）
  usage?: LLMUsage;    // 子循环整树用量（reactLoop 上卷进父 run 台账）
  turns?: number;      // 子循环整树轮数
  trace?: AgentTrace;  // enableTracing=true 时携带（发 subagent_call 事件）
}
```

- **常规 tool**：返回 `unknown`（不变,向后兼容）
- **sub-agent 调用**：[Agent.executeSubAgent](./agent.md) 把默认 reactLoop 的子循环结果统一包装为 `SubAgentToolResult`（无论 tracing 开关——用量上卷不依赖 tracing）；tracing 开启时附 `trace` 字段
- **旧 `TracingToolResult`**（`{ __trace: true, result, trace }`）：reactLoop 仍兼容识别并发 `subagent_call` 事件,但无用量字段、不上卷——业务方直接调 `reactLoop` 自定义 `executeTool` 的存量代码不受影响

reactLoop 在收到返回值时检查 `__subAgent` / `__trace` 字段：
- 命中且 `trace` 存在 → 发出 `subagent_call` 事件（带 sub-trace）
- 命中但无 `trace`（旧结构必有 `trace`,新结构 tracing 关闭时无）→ 发出 `tool_call` 事件
- 未命中 → 发出 `tool_call` 事件

用量上卷语义（`usage` / `turns` 整树口径、自定义 run 计 0、循环控制不受影响）详见 [reactLoop.md](./reactLoop.md)「usage 与 turns 的整树口径」。

### Agent.executeSubAgent 传递 enableTracing

[Agent 类](./agent.md) 创建 subAgent 时把父 agent 的 `enableTracing` 传递给 subAgent,subAgent.run 返回的 `result.trace` 就是 sub-trace,附在 `SubAgentToolResult.trace` 返回给 reactLoop。

## 性能开销

| 场景 | 开销 |
| --- | --- |
| `enableTracing=false`（opt-out 关闭） | 零——无新对象构造,无 timing 调用,与现状完全一致 |
| `enableTracing=true`（默认） | 每轮 1 次 `performance.now()` 配对（< 1μs）+ 每事件构造一个对象（~100B）+ sub-agent 递归采集。100 轮 agent.run() 估算 < 10KB trace 对象 + < 1ms 总耗时 |

**默认开启,业务方在生产主路径显式关闭**：

```ts
// 生产路径关闭 tracing（如高 QPS 的 chat 端点）
const result = await agent.run(input, { enableTracing: false });
```

## 与现有字段的关系

| 字段 | 描述视角 | 与 trace 的关系 |
| --- | --- | --- |
| `messages` | LLM 视角——扁平消息数组,供下次调用作为上下文传入 | `trace.events` 里的 `llm_call.inputMessages` 是每轮快照,拼接后等价于 `messages` |
| `usage` | 累计 token（整树口径——主循环 + 全部 sub-agent 循环） | `trace.usage` 与 `result.usage` 同值;`llm_call.usage` 是主循环每轮分量,sub 循环分量在各层 sub-trace 里 |
| `turns` | 总轮数（整树口径） | `trace.turns` 与 `result.turns` 同值;事件 `turn` 序号是主循环口径 |
| `stopReason` | 最终停止原因 | `trace.stopReason` 与 `result.stopReason` 同值 |
| `content` | 最终内容 | `trace.content` 与 `result.content` 同值 |

**不重复原则**：trace 不复制 messages 全量（每轮 `inputMessages` 是该轮快照,有重复但便于单独重放）,顶层 trace 与 result 同名字段是同值的便捷镜像,不是独立数据源。

## 限制

- trace 只描述**单次** `agent.run()` 的明细,跨请求的会话历史需业务方自行持久化 `result.messages` 后续传给下次调用
- trace 不采集 LLM provider 内部的网络 / 重试 timing（如 OpenAI SDK 的 retry）——只采集 `provider.complete()` / `provider.stream()` 调用边界的耗时
- sub-agent trace 嵌套深度受 `maxAgentDepth` 限制（与 sub-agent 递归本身的深度上限一致）

## 相关模块

- [reactLoop](./reactLoop.md) — trace 在 reactLoop / reactLoopStream 内部采集,通过 ReactLoopResult / ReactLoopStreamChunk 暴露
- [agent](./agent.md) — Agent.executeSubAgent 传递 enableTracing 给 subAgent,子循环结果包装为 SubAgentToolResult 返回（trace 字段携带 sub-trace）
- [agentHandle](./agentHandle.md) — AgentRunOptions.enableTracing 控制单次调用是否开 tracing
- [provider](./provider.md) — LLMUsage / LLMMessage / LLMStopReason / LLMToolCall 类型来源
