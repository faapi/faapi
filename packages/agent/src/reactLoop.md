# reactLoop

一句话概括：ReAct（Reasoning + Acting）循环引擎——反复调 LLM、执行 tool、把结果回传 LLM，直到 LLM 给出最终回答或达到 `maxTurns` 上限。

## 为什么需要

[Agent 类](./agent.md)（Phase 3.4）需要把用户输入 + 可用 tool 列表发给 LLM，LLM 可能：
- **直接回答** → 返回 content，循环结束
- **请求调 tool** → 返回 `tool_calls`，reactLoop 执行 tool，把结果塞回 messages，再调 LLM
- **多轮调用** → 反复 tool → result → LLM → tool → result → LLM …

如果把这个循环逻辑写在 Agent 类里，Agent 类会臃肿且难以独立测试。`reactLoop` 把"LLM ↔ tool 交互循环"抽成独立引擎，Agent 类只需提供 `provider` + `executeTool`，reactLoop 负责编排。

## 使用场景

- [Agent 类](./agent.md) 的 `run()` 调 `reactLoop()` 拿最终结果
- [Agent 类](./agent.md) 的 `stream()` 调 `reactLoopStream()` 拿流式 chunk（增量 token + tool 事件 + 最终结果）
- agent-as-tool 递归：`executeTool` 内部识别 `agent.` 前缀的 tool 名，递归调子 agent 的 `reactLoop`（`maxAgentDepth` 防护由 Agent 类在 `executeTool` 内实现）

## 设计

### 核心类型

| 类型 | 说明 |
| --- | --- |
| `ToolExecutor` | tool 执行函数 `(name, args) => Promise<unknown>`，由 Agent 类提供 |
| `ReactLoopConfig` | 循环配置（provider + systemPrompt + tools + executeTool + maxTurns + model 等） |
| `ReactLoopResult` | 非流式返回（content + messages + turns + stopReason + usage） |
| `ReactLoopStreamChunk` | 流式 chunk（deltaContent + toolCall + toolResult + done） |
| `ReactLoopError` | 系统级错误（maxTurns 超限），tool 执行错误不抛此类型 |

### `reactLoop(input, config)` 流程

1. 构造初始 messages：可选 `system` prompt + `user` input
2. 进入循环（`turns < maxTurns`）：
   - 调 `provider.complete()` 发送 messages + tools
   - 累积 `usage`（多轮 token 用量累加）
   - 把 assistant 消息 push 到 messages
   - 若 `stopReason !== 'tool_calls'` 或无 `toolCalls` → 返回最终结果
   - 遍历 `toolCalls`，逐个调 `executeTool(name, args)`
   - tool 执行错误被 catch，错误消息作为 tool 结果回传 LLM（LLM 可自我恢复）
   - tool 结果 push 到 messages（role='tool' + toolCallId）
3. 超出 `maxTurns` → 抛 `ReactLoopError`

### `reactLoopStream(input, config)` 流程

1. 同 `reactLoop` 的初始 messages 构造
2. 进入循环：
   - 调 `provider.stream()` 异步迭代 chunks
   - `deltaContent` chunk → yield `{ deltaContent }`
   - 累积 `turnContent`（当前轮的全部 token）
   - 终止 chunk（含 `finishReason`）：
     - `tool_calls` → yield 每个 `{ toolCall }`，执行 tool，yield `{ toolResult }`，继续循环
     - `stop` / 其他 → yield `{ done: { content, turns, stopReason, usage } }`，return
3. 超出 `maxTurns` → 抛 `ReactLoopError`

### Tool 错误处理策略

| 错误来源 | 处理 |
| --- | --- |
| `executeTool` 抛错 | catch，错误消息作为 tool 结果回传 LLM（`"Error: <message>"`） |
| `provider.complete/stream` 抛错 | 立即传播（LLM API 故障不可恢复） |
| `maxTurns` 超限 | 抛 `ReactLoopError` |

tool 执行错误回传 LLM 是业界惯例（OpenAI Agents SDK / LangChain / CrewAI 均如此）——LLM 可以根据错误信息改用其他 tool 或调整参数。

### `maxTurns` 语义

- 一轮 = 一次 LLM 调用（含可能的 tool 执行）
- `maxTurns` 默认 `10`（由 [AgentConfig](../../faapi/src/config/configTypes.md).maxTurns 提供）
- agent 自身 `config.maxTurns` 覆盖全局默认
- 超出时抛 `ReactLoopError`，包含已用轮数和 maxTurns 值

### `maxAgentDepth` 防护

reactLoop 本身不跟踪 agent 递归深度——`maxAgentDepth` 防护在 [Agent 类](./agent.md) 的 `executeSubAgent` 实现中：

```ts
// Agent 类的 executeSubAgent（简化,详见 agent.md）
private async executeSubAgent(subName: string, args: Record<string, unknown>) {
  const newDepth = this.depth + 1;
  const maxDepth = this.deps.config?.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH;  // 默认 3
  if (newDepth > maxDepth) throw new AgentRecursionError(maxDepth, newDepth);
  // 构造子 agent（depth+1）并调其 run
  const subAgent = new Agent({ ...this.deps, agentName: subName }, newDepth);
  return subAgent.run(typeof args === 'string' ? args : JSON.stringify(args));
}
```

reactLoop 调 `executeTool` 时,`agent.` 前缀的 tool 名触发 `executeSubAgent`——若子 agent 超出深度限制,抛 `AgentRecursionError`,reactLoop catch 后把错误消息回传 LLM。

### 与 provider 的关系

reactLoop 只依赖 [LLMProvider](./provider.md) 接口（`complete` / `stream`），不直接 import 任何 provider 实现。Agent 类负责创建 provider 实例并传入 `ReactLoopConfig.provider`。

### 流式 chunk 设计

```ts
interface ReactLoopStreamChunk {
  /** LLM 增量 token（多轮累积，每轮从空开始） */
  deltaContent?: string;
  /** tool 开始执行（LLM 请求调用 tool） */
  toolCall?: { name: string; arguments: Record<string, unknown> };
  /** tool 执行完成（含结果，供 UI 展示） */
  toolResult?: { name: string; result: string };
  /** 循环结束（最终结果） */
  done?: { content: string; turns: number; stopReason: LLMStopReason; usage?: LLMUsage };
}
```

每个 chunk 至多含一个字段。`deltaContent` 在 LLM 流式输出时多次 yield；`toolCall`/`toolResult` 在 tool 执行时配对 yield；`done` 只在结束时 yield 一次。

## 取消（AbortSignal）

`ReactLoopConfig.signal` 透传到每轮 LLM 请求。循环每轮开始前预检查：已取消抛 `AgentAbortError`（provider 未被调用）；执行中取消由 provider 请求中断传播（同样抛 `AgentAbortError`）。tool 执行不被取消（业务自决）。业务方通过 `instanceof AgentAbortError` 区分取消与真实错误（不触发告警/重试）。

## 相关模块

- [provider](./provider.md) — `LLMProvider` 接口、`LLMMessage` / `LLMToolCall` / `LLMResponse` 等类型
- [Agent 类](./agent.md)（Phase 3.4）— 调用方，提供 `provider` + `executeTool` + `tools`
- [toolRegistry](../../faapi/src/injection/toolRegistry.md) — `executeTool` 内部按名查找 tool
- [agentRegistry](../../faapi/src/injection/agentRegistry.md) — `executeTool` 内部按名查找子 agent
