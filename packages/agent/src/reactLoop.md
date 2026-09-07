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
| `ReactLoopError` | 系统级错误（maxTurns 超限，携带中断时 messages 供续跑），tool 执行错误不抛此类型 |

### `reactLoop(input, config)` 流程

1. 构造初始 messages：`config.messages` 提供时以其为基础（续跑 / 多轮对话，语义见中断恢复章节）；否则可选 `system` prompt + `user` input
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
- 超出时抛 `ReactLoopError`，包含已用轮数、maxTurns 值和**中断时的完整 `messages`**（业务方可提高 maxTurns 后传入 `config.messages` 续跑，轮数重新计数）

### 同轮 tool_call 并行执行

LLM 一轮可返回多个 tool_call，非流式路径**并行执行**（`Promise.all`）——总耗时从各 tool 之和降为最慢一个。语义约束：

- **结果按 toolCalls 声明顺序回传**（与完成顺序无关），tool 消息与 id 的配对语义不变
- **每个 toolCall 独立 try/catch**——单个失败不影响其余的结果回传
- **`beforeToolCall` / `afterToolCall` 钩子会并发触发**——业务方钩子不应依赖调用顺序（读 ctx 做鉴权/改写与顺序无关）
- 流式路径（`reactLoopStream`）保持**串行**——chunk 的 yield 顺序受消费端约束

### 历史裁剪（`maxHistoryTokens`）

多轮 tool 循环中 `messages` 只增不减，大 tool 结果（如整个文件内容）会把对话历史撑爆模型上下文窗口——下一轮 LLM 直接 400，整个 run 失败。`ReactLoopConfig.maxHistoryTokens`（token 预算，未设置 = 不裁剪，向后兼容）按预算裁剪**发给 LLM 的**消息：

- **裁剪单位是「轮组」**：一条 assistant 消息（可能带 toolCalls）+ 其后全部对应 tool 结果。以轮组为原子单位保证 OpenAI 的 tool 配对约束不被破坏（不裁半轮）
- **永不裁剪**：system 消息 + 初始 user 输入（用户目标保留，丢的是中间过程）
- **至少保留最近一轮**：即使最新轮组自己超预算也保留（不发送空历史）
- **token 为近似估算**（`字符数 / 2`，中英混合保守值），不引入 tokenizer 依赖
- **本地历史不丢**：裁剪只作用于每轮发给 LLM 的消息副本，`messages` 本体与 trace 的 `inputSnapshot` 完整性不受影响（`inputSnapshot` 记录的是实际发送的裁剪后消息）
- 非流式与流式两条循环行为一致

取舍：被裁掉的旧轮组不生成摘要（compaction 属后续能力）——需要保留长期上下文的场景应在 tool 内控制返回体积，或用 `maxTurns` 控制总轮数。

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

`AgentAbortError` 携带 `messages` 属性——中断时刻的部分对话历史，供业务方持久化后续跑（见下节）。

## 中断恢复（Resume）

一句话概括：中断 / 超限时错误对象携带部分对话历史，业务方持久化后通过 `config.messages` 从断点续跑，不必从头重跑已完成的轮次。

### 为什么需要

`run` 中断（客户端断开、服务重启、请求超时被取消）时，已执行的 LLM 轮次与 tool 结果如果丢失，重试只能从头再来——tool 有副作用（发消息、写库）时重复执行不可接受。恢复机制把「中断点之前的历史」交给业务方，重试变为「续跑」。

### 错误对象携带历史

| 错误 | `messages` 内容 | 续跑方式 |
| --- | --- | --- |
| `AgentAbortError` | 中断时刻的部分历史（截至最后一个**完整轮组**） | `agent.run(undefined, { messages: err.messages })` |
| `ReactLoopError`（maxTurns 超限） | 已完成的全部历史（循环正常走完 N 轮） | 提高 maxTurns 后同上传入 |

**轮组原子性**：中断只可能发生在 LLM 请求期间或轮次边界——assistant 消息在 provider 返回完整响应后才 push，tool 结果在其后紧随。因此错误携带的 `messages` 天然满足「assistant.toolCalls 与其后 tool 结果完整配对」，可直接回传 LLM。流式路径中断时当前轮已 yield 的 `deltaContent` 属于未完成轮组，不入历史（与历史裁剪的轮组原子语义一致）。

### `config.messages` 续跑语义

`ReactLoopConfig.messages: LLMMessage[]` 提供时：

1. **以历史为基础**——不再构造初始 system + user（历史应含此前轮次的全部消息）
2. **system 自动补齐**——历史中无 `system` 消息且配置了 `systemPrompt` 时，在最前插入（agent 人格/规则不因续跑丢失；`AgentAbortError.messages` 天然含 system，此规则是对业务方自构造历史的容错）
3. **`input` 追加**——`input` 非空字符串时追加为新的 `user` 消息（多轮对话场景）；`input` 为空（`undefined` / `''`）时纯续跑；两者都为空抛 `AgentError`
4. **结构校验**——历史中 assistant 消息带 `toolCalls` 时，其后必须紧跟对应数量的 `tool` 结果消息（按 `toolCallId` 配对），缺失抛 `AgentError`（早失败优于 LLM API 400 模糊报错——常见诱因是业务方持久化/反序列化时截断在轮组中间）
5. **续跑历史同样受 `maxHistoryTokens` 裁剪**——发给 LLM 的副本按预算裁剪，本地历史不受影响

### 续跑轮数重新计数

续跑是新的一次 `run`——`maxTurns` 从 0 重新计数，`usage` 只累计本次调用的 token。跨次调用需要业务方自行持久化。

### 使用场景

- SSE / WebSocket 客户端断开后重连，从断点继续（`req.signal` abort → `AgentAbortError.messages` 入库 → 重连带 `messages` 续跑）
- maxTurns 超限（LLM 循环调 tool 未收敛）后提高预算续跑
- 多轮对话：每次请求把上次保存的 `result.messages` 传入 `messages` + 新输入追加

### 相关代码

```ts
// handler：断点保存 + 重连续跑
export async function POST(agent: AgentHandle, ctx, body: { input: string }) {
  const history = await loadHistory(ctx.sessionId);           // 上次保存的历史（可为空）
  try {
    const result = await agent.run(body.input, { messages: history });
    await saveHistory(ctx.sessionId, result.messages);        // 正常结束保存完整历史
    return { content: result.content };
  } catch (err) {
    if (err instanceof AgentAbortError) {
      await saveHistory(ctx.sessionId, err.messages);         // 断点保存
    }
    throw err;  // 客户端重试时走同一 handler，loadHistory 拿到断点历史续跑
  }
}

## 相关模块

- [provider](./provider.md) — `LLMProvider` 接口、`LLMMessage` / `LLMToolCall` / `LLMResponse` 等类型
- [Agent 类](./agent.md)（Phase 3.4）— 调用方，提供 `provider` + `executeTool` + `tools`
- [toolRegistry](../../faapi/src/injection/toolRegistry.md) — `executeTool` 内部按名查找 tool
- [agentRegistry](../../faapi/src/injection/agentRegistry.md) — `executeTool` 内部按名查找子 agent
