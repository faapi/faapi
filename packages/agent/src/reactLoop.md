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
- agent-as-tool 递归：`executeTool` 内部按声明集合识别 sub-agent 派发名（`agent-<name>`,命名见 [subAgentToolName](../../faapi/src/injection/subAgentToolName.md)）,递归调子 agent 的 `reactLoop`（`maxAgentDepth` 防护由 Agent 类在 `executeTool` 内实现）

## 设计

### 核心类型

| 类型 | 说明 |
| --- | --- |
| `ToolExecutor` | tool 执行函数 `(name, args) => Promise<unknown>`，由 Agent 类提供 |
| `ReactLoopConfig` | 循环配置（provider + systemPrompt + tools + executeTool + maxTurns + model 等） |
| `ReactLoopResult` | 非流式返回（content + reasoning + messages + turns + stopReason + usage + traceId + trace）；`usage` / `turns` 为整树口径（见「usage 与 turns 的整树口径」章节）；`traceId` 由 Agent 层填充（循环不感知,见 [traceId.md](./traceId.md)） |
| `ReactLoopStreamChunk` | 流式 chunk（deltaContent + deltaReasoning + toolCall + toolResult + subagentEvent + done）；`done.usage` / `done.turns` 同整树口径；`done.messages` 为最终完整历史（与非流式 `ReactLoopResult.messages` 同源对齐） |
| `SubAgentToolResult` | sub-agent tool 的结构化返回值（`{ __subAgent: true, result, usage?, turns?, trace? }`），reactLoop 识别后上卷用量、剥壳回传（见「usage 与 turns 的整树口径」章节） |
| `ReactLoopError` | 系统级错误（maxTurns 超限，携带中断时 messages 供续跑），tool 执行错误不抛此类型 |

### `reactLoop(input, config)` 流程

1. 构造初始 messages：`config.messages` 提供时以其为基础（续跑 / 多轮对话，语义见中断恢复章节）；否则可选 `system` prompt + `user` input
2. 进入循环（`turns < maxTurns`）：
   - 调 `provider.complete()` 发送 messages + tools
   - 累积 `usage`（多轮 token 用量累加）
   - 把 assistant 消息 push 到 messages（`reasoning_content` 剥离后，见 thinking 章节）
   - 若 `stopReason !== 'tool_calls'` 或无 `tool_calls` → 返回最终结果
   - 遍历 `tool_calls`，arguments JSON 字符串 parse 后逐个调 `executeTool(name, args)`（解析边界收拢在 reactLoop，tool 执行函数 / 鉴权订阅端 / trace 拿到已 parse 对象）
   - tool 执行错误被 catch，错误消息作为 tool 结果回传 LLM（LLM 可自我恢复）
   - tool 结果为 `SubAgentToolResult` 时先上卷 `usage` / `turns`（整树口径，见下节）再剥壳回传
   - tool 结果 push 到 messages（role='tool' + tool_call_id）
3. 超出 `maxTurns` → 抛 `ReactLoopError`

### `reactLoopStream(input, config)` 流程

1. 同 `reactLoop` 的初始 messages 构造
2. 进入循环：
   - 调 `provider.stream()` 异步迭代 chunks
   - `deltaContent` chunk → yield `{ deltaContent }`
   - `deltaReasoning` chunk → yield `{ deltaReasoning }`（含中间 tool 轮的推理内容）
   - 累积 `turnContent` / `turnReasoning`（当前轮的全部 token / 推理内容）
   - 终止 chunk（含 `finishReason`）：
     - `tool_calls` → yield 每个 `{ toolCall }`，执行 tool，yield `{ toolResult }`（`SubAgentToolResult` 先上卷 `usage` / `turns` 再剥壳，与非流式一致），继续循环
     - `stop` / 其他 → yield `{ done: { content, reasoning, turns, stopReason, usage, messages } }`（`usage` / `turns` 整树口径；`messages` 为最终完整历史，与非流式 `ReactLoopResult.messages` 同源），return
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
- `maxTurns` 默认 `10`（由 [AgentConfig](../../faapi/src/configs/configTypes.md).maxTurns 提供）
- agent 自身 `config.maxTurns` 覆盖全局默认
- 超出时抛 `ReactLoopError`，包含已用轮数、maxTurns 值和**中断时的完整 `messages`**（业务方可提高 maxTurns 后传入 `config.messages` 续跑，轮数重新计数）

### 同轮 tool_call 并行执行

LLM 一轮可返回多个 tool_call，非流式路径**并行执行**（`Promise.all`）——总耗时从各 tool 之和降为最慢一个。语义约束：

- **结果按 tool_calls 声明顺序回传**（与完成顺序无关），tool 消息与 id 的配对语义不变
- **每个 toolCall 独立 try/catch**——单个失败不影响其余的结果回传
- **`agent:before-tool-call` / `agent:after-tool-call` 事件会并发触发**——订阅端不应依赖事件顺序（读 ctx 做鉴权/改写与顺序无关）
- 流式路径（`reactLoopStream`）保持**串行**——chunk 的 yield 顺序受消费端约束

### usage 与 turns 的整树口径（sub-agent 冒泡）

`ReactLoopResult.usage` / `turns`（流式为 `done.usage` / `done.turns`）是**整树口径**——不只主循环，所有层级的 sub-agent 循环用量与轮数都逐层上卷：

- `usage` = 本次 run 全部 `llm_call` usage 之和（主循环 + 全部 sub-agent 循环，多层递归天然聚合）
- `turns` = 主循环轮数 + 全部 sub-agent 循环轮数

**为什么需要**：多 agent 场景下子代理循环才是 token 大头，若 `usage` 只含主循环，业务方按 run 落用量台账会系统性低估（GAP-1，writer 拆书场景逐章成本失真）。子循环用量必须冒泡到父 run 的台账口径。

**机制**：sub-agent 走默认 reactLoop 时，[Agent.executeSubAgent](./agent.md) 把子循环结果包装为 `SubAgentToolResult` 返回——子循环的 `usage` / `turns` 已是其自身整树口径（sub-sub 先在子循环上卷），reactLoop 识别 `__subAgent` 标记后把 `usage` 累加进本循环用量、`turns` 累加进结果轮数，随后剥壳取 `result` 作为 tool 消息回传 LLM（LLM 视角与上卷机制无关，回传内容不变）：

```ts
export interface SubAgentToolResult {
  __subAgent: true;      // 标记字段
  result: unknown;       // 子代理最终 content（剥壳后回传 LLM）
  usage?: LLMUsage;      // 子循环整树用量（缺省 = provider 未返回用量）
  turns?: number;        // 子循环整树轮数
  trace?: AgentTrace;    // enableTracing=true 时携带（发 subagent_call 事件）
}
```

**边界与不变式**：

- **循环控制不受影响**：`maxTurns` 循环计数与 trace 事件的 `turn` 序号始终是**主循环口径**——子代理轮数不挤占父循环的 `maxTurns` 预算，`llm_call.turn` / `tool_call.turn` / `subagent_call.turn` 序号保持 1..N 连续
- **trace 顶层同口径**：`AgentTrace.turns` / `usage` 与 `ReactLoopResult` 同值（整树）；各层 sub-trace 自带各自的整树用量，业务方可还原逐层明细
- **兼容**：reactLoop 同时识别旧 `TracingToolResult`（`{ __trace: true, result, trace }`，无用量字段，仅触发 `subagent_call` 事件、不上卷用量）——业务方直接调 `reactLoop` 自定义 `executeTool` 的存量代码不受影响；新代码用 `SubAgentToolResult`

> **Breaking**：`usage` 语义由「本次 run 主循环用量」升级为「整树用量」，`turns` 同口径聚合。按主循环口径消费的业务方需自行调整落库口径（版本与迁移说明见 changeset / CHANGELOG）。

### `agent:history-over-budget` 历史超限事件（压缩的业务承接面）

历史长度控制**完全是业务知识**——框架不内置任何裁剪/压缩（无默认截断、无压缩策略位）。`ReactLoopConfig.maxHistoryTokens`（来自 `AgentRuntimeConfig`，子代理共享根 deps 全树生效）只是**超限阈值**（近似估算：字符数 / 2，不引入 tokenizer 依赖）：每轮 LLM 调用前估算历史 tokens（输入轮在 `agent:input` 落账之后——落账内容参与当轮判定），超过阈值时经 `appEvent` 发射 [appEventBus](../../faapi/src/events/appEventBus.md) 的 `agent:history-over-budget` 与 `agent:history-over-budget:<agentName>`（先通用后专属，同一载荷对象）：

- **载荷**：`{ depth, estimatedTokens, budget, messages, ctx, replace }`——`messages` 为当前历史只读快照（同 `agent:input` 口径：深冻结克隆，写操作抛错）。
- **`replace(history)`**：业务压缩产物**整体替换循环历史**——落账语义：后续轮次、`result.messages` / `done.messages`、断点/续跑链全部可见且不可变。压缩后如同开启一段新对话，但**不会触发 `agent:root-input` 重发射**（root-input 只在循环启动前对非空 input 发射，循环中途不重发）；当轮发送即用替换后历史，本次事件不重入（至多一次），后续轮次重新估算、仍超限再发射。
- **多 handler**：后调 `replace` 覆盖先调（与 `agent:sub-agent-context` 同覆盖口径）；不调 = 历史原样发送。
- **扇出后校验**：调用了 `replace` 时产物必须非空且结构完整（消息角色合法 + `assistant.tool_calls` 与 tool 结果按 `tool_call_id` 配对完整——与续跑历史同款约束，断裂结构每次发送都会被 provider 400），违反抛 `AgentError`（fail fast，替换不生效）。
- **事务性**：订阅端抛错 → 替换未发生、历史零污染，错误走 run / stream 既有错误链。
- **未超限 / 未设置 `maxHistoryTokens` / `appEvent` 未接线**：事件不发射、历史原样（能力边界，非降级）——**未订阅事件时超限历史原样发送**，provider 因超长返回 400 是显式边界（长度控制是业务知识）。
- **trace 一致**：`inputSnapshot` 记录实际发送的消息（含替换后历史）。

### `agent:input` 用户输入发送前事件（历史编辑窗口）

`ReactLoopConfig.appEvent` 已接线（`buildLoopConfig` 自 `AgentDeps.emitAppEvent` 透传）时，**当轮有新 user 输入**的轮次在 provider 调用前、超限事件**之前**，经其发射 [appEventBus](../../faapi/src/events/appEventBus.md) 的 `agent:input` 与 `agent:input:<agentName>`（先通用后专属，同一载荷对象顺序串联）：

- **触发语义 = 有 user 输入消息的轮**：`input` 指当轮新增的 role=user 消息——loop 首轮非空 `input` 时发射（根调用与子代理派发同口径；续跑携带新输入 `run('补充指令', { messages })` 同属输入轮，照常发射），每个 loop 恰好一次。**工具轮 / 纯续跑轮（当轮无新 user 输入）不发射**——塑形窗口附着在真实输入消息上，没有可塑形的 user 消息就不发事件，也**不虚构新增 user 消息**承载订阅端片段（跨轮注入走 `agent:system-prompt` 等 per-run 接缝或业务自行编排）。
- **载荷**：`{ depth, messages, ctx, addInput }`——不含 agent 名（按 agent 路由订阅专属名 `agent:input:<agentName>`，名字在事件名里）。
  - `messages`：**历史只读快照**（`structuredClone` 深拷贝 + 逐层深冻结）——读取口径，任何写操作（数组结构变更 / 消息对象字段赋值）抛 `TypeError`；对 `messages` 整体替换赋值抛 `TypeError`（getter-only）（历史快照不开放改写）。
  - `addInput(text, index = 100)`：**补充输入**（唯一写面）——暂存文本片段，扇出结束后落账。
- **落账语义（append-only 不可变账本）**：片段按 index 升序稳定排序（同 index 保持调用序——比较器显式双键 `(index, seq)`，不依赖引擎稳定排序）→ 过滤空白片段 → `'\n\n'` 拼接 → 前置进**当轮输入消息** content 之前（原内容逐字节不动）。当轮输入消息以循环启动时捕获的**消息引用**定位（`indexOf` 回查 + `role === 'user'` 断言）——附着目标是那条真实 user 消息而非数组位置，「新输入在末条」的构造事实被未来改动破坏时显式抛错（框架内部不变量），不静默改写错位。**`{{rawInput}}` 占位符**：拼接结果含该占位符时，占位符全部展开为当轮输入原内容——原输入嵌在订阅端指定的位置、不再缀尾（片段产物与原输入互斥，位置由占位符裁决，如 `'规则…\n\n<user_input>{{rawInput}}</user_input>'`）；不含占位符时维持前置 + 原内容缀尾。单次展开不递归（原内容含字面占位符不二次处理）。落账后即历史的一部分：后续轮次、`result.messages` / `done.messages`、断点/续跑链全部可见且不可变。
- **合并边界 = 单次事件发射**：跨 agent（depth 层级）、跨 run 各自独立暂存独立落账，永不跨边界合并。多监听（通用名 + 专属名 + 同名多订阅）的片段合并为**一条** user 消息，不是多条消息。**唯一的跨事件合并是 loop 首轮**：`agent:root-input`（循环启动前由 `buildLoopConfig` 发射，片段暂存在 `ReactLoopConfig.appEvent.rootInputStaging`）与首轮 `agent:input` 的片段进同一次落账——同一套排序 / 过滤 / 拼接 / `{{rawInput}}` 展开，合并为一条首条 user 消息；root-input 片段 seq 更早，同 index 下排在 `agent:input` 片段之前。
- **顺序契约**：`[root-input 片段…] + [agent:input 片段…] + [当轮输入]`（按 index 排序后拼接，缺省 index 100 下即此序；`{{rawInput}}` 在场时原输入改嵌占位符位置、不再缀尾）——首条 user 消息的包裹形态由两路 `addInput` 订阅端共同决定，包裹格式不进框架（业务约定，如 `<system-reminder>` / `<user_input>`）。
- **触发面**：仅输入轮——loop 首轮非空 `input`（根调用 / 子代理派发同口径），每 loop 恰好一次；工具轮 / 纯续跑轮零发射（事件与落账都不发生，历史零扰动）。
- **事务性**：任一订阅端抛错 → 暂存未落账、历史零污染，错误走 run / stream 既有错误链（发起 LLM 请求前显式失败，fail fast，不吞不降级）。
- **与超限事件的次序**：超限事件每轮发射；输入轮片段落账后才估算 tokens（`agent:history-over-budget`）——落账内容参与当轮超限判定；trace 的 `inputSnapshot` 记录实际发送的消息（含落账片段与替换后历史），与「trace 如实反映发送内容」纪律一致。
- **读不到暂存**：`messages` 快照 = 发射时刻的历史，不含本轮已暂存片段（片段在扇出结束才落账，中途可见会引入读写竞争）。
- **未接线**：`appEvent` 缺席 → 事件不发射、行为原样（能力边界，非降级）。

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

reactLoop 调 `executeTool` 时,sub-agent 派发名（`agent-<name>`,按 `Agent` 构建期的「派发名 → agent 名」声明映射识别,不按名字前缀猜测）触发 `executeSubAgent`——若子 agent 超出深度限制,抛 `AgentRecursionError`,reactLoop catch 后把错误消息回传 LLM。

### 与 provider 的关系

reactLoop 只依赖 [LLMProvider](./provider.md) 接口（`complete` / `stream`），不直接 import 任何 provider 实现。Agent 类负责创建 provider 实例并传入 `ReactLoopConfig.provider`。

### 流式 chunk 设计

```ts
interface ReactLoopStreamChunk {
  /** LLM 增量 token（多轮累积，每轮从空开始） */
  deltaContent?: string;
  /** LLM 推理内容增量（thinking 模型，见 thinking 章节） */
  deltaReasoning?: string;
  /** tool 开始执行（LLM 请求调用 tool） */
  toolCall?: { name: string; arguments: Record<string, unknown> };
  /** tool 执行完成（含结果，供 UI 展示） */
  toolResult?: { name: string; result: string };
  /** 嵌套子代理循环的中间事件（冒泡透传，见「子代理事件冒泡」章节） */
  subagentEvent?: SubAgentEvent;
  /** 循环结束（最终结果）；`messages` 为最终完整历史（含最终 assistant 消息，已剥离推理内容），与非流式 `ReactLoopResult.messages` 同源——流式消费方持久化后经 `config.messages` 续跑（挂起/恢复编排）不必走异常路径 */
  done?: { content: string; reasoning?: string; turns: number; stopReason: LLMStopReason; usage?: LLMUsage; traceId?: string; messages: LLMMessage[] };
}
```

每个 chunk 至多含一个字段。`deltaContent` / `deltaReasoning` 在 LLM 流式输出时多次 yield；`toolCall`/`toolResult` 在 tool 执行时配对 yield；`subagentEvent` 由子循环事件实时冒泡；`done` 只在结束时 yield 一次。

### 子代理事件冒泡（流式）

子代理（`agent-<name>` 派发 tool call）在 `executeSubAgent` 内递归跑自己的循环。流式父循环执行 sub-agent 时，子循环的一切中间事件（LLM 增量、tool 调用、tool 结果）经统一的 `subagentEvent` chunk **实时冒泡**到父流——多 agent 协作页面可直播子代理的完整工作过程：

```ts
export type SubAgentEvent =
  | {
      /** 事件形态判别：LLM 增量（deltaContent / deltaReasoning 至少存在其一） */
      type: 'delta';
      /** 发起调用的派发 tool 名（agent-<name>） */
      name: string;
      /** 该子代理循环的递归深度（根循环 = 1,首次嵌套的子代理 = 2,与 maxAgentDepth 口径一致） */
      depth: number;
      deltaContent?: string;
      deltaReasoning?: string;
    }
  | { type: 'tool_call'; name: string; depth: number; toolName: string; arguments: Record<string, unknown> }
  | { type: 'tool_result'; name: string; depth: number; toolName: string; result: string };

interface ReactLoopStreamChunk {
  // …现有字段…
  /** 嵌套子代理循环的中间事件（冒泡透传;仅流式路径,与现有字段互斥） */
  subagentEvent?: SubAgentEvent;
}
```

- **单一通道**：delta、tool_call、tool_result 三形态共用同一 chunk 字段,`type` 判别。`name` 恒为该子代理的派发工具名、`depth` 恒为该子代理循环深度;`toolName` 为子代理自己调用的 tool 名（含其派发孙代理的 `agent-<孙名>`——子代理的派发调用也是 tool call,统一转发不特判）。孙代理事件经各层原样透传（name/depth 已由所属循环标注）
- **机制**：`await executeTool` 期间 async generator 挂起无法 yield——流式路径对每个 tool call 采用 fire-and-drain 泵：fire executeTool（携带 emitter）→ 子循环事件经 `onSubAgentEvent` push 进单队列并唤醒 → generator 循环 drain 逐个 yield `subagentEvent` → executeTool 完成后 flush 剩余。单队列保序：冒泡顺序即子代理内实际发生顺序；流式路径同轮多 tool_call 串行执行,天然有序
- **子循环升级**：父为流式时 `executeSubAgent` 让子循环也跑流式（`subAgent.stream()`）——非流式子循环没有事件可实时冒泡给父流。done/trace 语义不变：父侧从子流 `done` chunk 拼装与 `run()` 等价的结果（content/usage/turns）,tracing 开启时从子流 `traceEvent` 收集拼装 `AgentTrace`（结构不变,`subagent_call` 嵌套 trace 不回归）
- **不转发 traceEvent / done**：trace 事件经 `SubAgentToolResult.trace` 嵌入父 trace 树（派发结束后一次性可见）,done 供结果拼装——两者不进事件流,避免重复。显式能力边界：实时直播走 `subagentEvent`,完整过程回放走 tracing（见 [trace.md](./trace.md)）
- **错误自然冒泡**：子代理 tool 执行失败时其循环已 yield `tool_result`（错误串）,事件流自然可见,无专用错误通道
- **非流式路径不受影响**：父循环非流式时结果一次性返回,无冒泡需求
- **语义不变式**：嵌套 `reasoning_content` 依旧**不进** messages 历史与续跑源（事件仅透出给调用方,与 thinking 章节的剥离纪律一致）;`ReactLoopResult` / trace 结构不受影响;中断/`maxAgentDepth`/历史剥离全部不回归

### thinking（推理内容）

thinking 模型（DeepSeek-R1 / Qwen-thinking / OpenAI o 系列等）在 `content` 之外返回推理过程。reactLoop 层的策略：**推理内容只透出给调用方，不进入对话历史**。

- **透出**：非流式 `ReactLoopResult.reasoning`（最终轮 assistant 的推理内容，多轮时中间轮的推理不保留）；流式 `deltaReasoning` chunk 逐段透传（含中间 tool 轮——业务方可完整展示"思考中"过程），`done.reasoning` 为最终轮的完整推理内容
- **历史剥离**：assistant 消息 push 进 `messages` 前剥离 `reasoning_content`——历史是发给 LLM 的（DeepSeek 多轮回传推理内容直接 400）也是持久化 / 续跑 / `AgentAbortError.messages` / `ReactLoopError.messages` 的来源，保持 OpenAI 线格式纯净。剥离在 `reasoning_content` 存在时才浅拷贝，常态零拷贝
- **trace 保留**：`llm_call` 事件的 `response` 记录该轮 LLM 的**原始**返回（含 `reasoning_content`）——观测/调试需要完整原始数据，与历史的剥离策略互补，详见 [trace.md](./trace.md)

非流式与流式的差异：非流式只有 `ReactLoopResult.reasoning` 一个出口（最终轮）；流式因消费端逐 chunk 消费，中间轮推理经 `deltaReasoning` 已透出，`done.reasoning` 仅覆盖最终轮。

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

**轮组原子性**：中断只可能发生在 LLM 请求期间或轮次边界——assistant 消息在 provider 返回完整响应后才 push，tool 结果在其后紧随。因此错误携带的 `messages` 天然满足「assistant.toolCalls 与其后 tool 结果完整配对」，可直接回传 LLM。流式路径中断时当前轮已 yield 的 `deltaContent` 属于未完成轮组，不入历史（轮组原子语义）。

### `config.messages` 续跑语义

`ReactLoopConfig.messages: LLMMessage[]` 提供时：

1. **以历史为基础**——不再构造初始 system + user（历史应含此前轮次的全部消息）
2. **system 自动补齐**——历史中无 `system` 消息且配置了 `systemPrompt` 时，在最前插入（agent 人格/规则不因续跑丢失；`AgentAbortError.messages` 天然含 system，此规则是对业务方自构造历史的容错）
3. **`input` 追加**——`input` 非空字符串时追加为新的 `user` 消息（多轮对话场景）；`input` 为空（`undefined` / `''`）时纯续跑；两者都为空抛 `AgentError`
4. **结构校验**——历史中 assistant 消息带 `tool_calls` 时，其后必须紧跟对应数量的 `tool` 结果消息（按 `tool_call_id` 配对），缺失抛 `AgentError`（早失败优于 LLM API 400 模糊报错——常见诱因是业务方持久化/反序列化时截断在轮组中间）
5. **续跑历史同样受 `maxHistoryTokens` 裁剪**——发给 LLM 的副本按预算裁剪，本地历史不受影响

### 正常收尾的历史导出（挂起/恢复编排）

历史导出不只中断路径：非流式 `ReactLoopResult.messages`、流式 `done.messages` 均为**最终完整历史**（含最终 assistant 消息，已剥离推理内容，满足轮组原子性可直接续跑）。业务方的挂起/恢复编排（长任务分段：run 正常收尾即持久化历史，段间经任务队列续跑 `run(undefined, { messages })`）不需要制造异常来获取断点状态——run 正常结束本身就是一个合法挂起点。

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
