# historyCompaction（历史压缩策略位）

一句话概括：`maxHistoryTokens` 超预算时，业务可注入整体替换的压缩策略（`historyCompactor`）——框架拥有接缝位置与输出不变量守卫，摘要配方与持久化全部留业务；缺省不注入时逐字节保持现行「按轮组从最旧截断」行为。

## 为什么需要

`maxHistoryTokens` 超预算时框架只会把最旧轮组**丢弃**（不生成摘要，见 [reactLoop.md](./reactLoop.md) 历史裁剪章节自述「compaction 属后续能力」）。长对话要摘要式压缩（折叠早期轮次为滚动摘要）只能业务自搓——机械（超预算探测、策略调用点、输出不变量校验）每项目复刻，而摘要写什么、存哪、怎么注入全是业务决策。

## 使用场景

- 会话级持久折叠（业务实证形态）：业务用 [`createRollingSummaryCompactor`](./rollingSummary.md) 的 `plan` 在轮终态规划折叠 → 后台任务 `fold` 生成摘要并持久化 → 组装发送消息时 `block` 注入摘要块——策略位此时可完全不接（折叠是会话级持久方案，`maxHistoryTokens` 截断仍是 loop 级背后防线）
- in-loop 压缩（无持久化的项目）：接 `historyCompactor` 让每次发送前的超预算历史现场压缩（如调 LLM 生成摘要替换被裁轮组），结果只作用于发送副本

## 策略位

`ReactLoopConfig.historyCompactor` / `AgentRuntimeConfig.historyCompactor`（同一类型 [`HistoryCompactor`](./historyCompaction.ts)）：

```ts
historyCompactor?: (input: {
  messages: LLMMessage[]   // 超 budget 的完整发送候选(已含 system+初始 user)
  estimatedTokens: number  // 框架估算值(字符数/2)
  budget: number           // maxHistoryTokens
}) => Promise<LLMMessage[]> | LLMMessage[]
```

调用时机与位置：

- **接在现行裁剪的同一位置**（每轮发给 LLM 前），仅当「超预算且存在轮组（含 assistant 消息）」时调用——未超预算不调（不打扰正常路径）；无轮组时不调（无可折叠物，与现行 trimHistory 的 no-op 语义一致），回落现行截断
- **仅在发送副本上调用**：`result.messages` 与续跑源（本地 messages）不受影响——被压缩的只是该轮发给 LLM 的内容，与现行裁剪同口径
- **子代理递归共享根 deps**：`AgentRuntimeConfig.historyCompactor` 经 deps 全树生效（与现行裁剪同款传导），策略对派发的 sub 同样生效
- 未声明时走现行 `trimHistory` 截断，**逐字节现状**

## 输出不变量（框架强制守卫）

策略自由度以不变量为界，违反即抛 `AgentError`（含具体违反项），不静默放行坏历史：

1. **头部段必须保留**：system 消息与初始 user 输入（第一个 assistant 之前的连续前缀）必须按原顺序出现在输出最前（逐条 role + content 一致）——用户目标不丢
2. **tool 配对完整**：每条 assistant 的 `tool_calls` 与其后 tool 结果按 `tool_call_id` 配对完整（不裁半轮）；孤立 tool 消息（前一条 assistant 未调用对应 tool）同判违反
3. **至少保留最近一个轮组**：输出必须含至少一条 assistant 消息（不发送空历史）

## 测试要求映射

缺省=现状（既有裁剪测试全绿）｜不变量守卫（缺 system / 破坏配对 / 空历史显式抛错）｜超预算才调用｜子代理传导——见 [historyCompaction.test.ts](./historyCompaction.test.ts)。

## 相关模块

- [reactLoop.md](./reactLoop.md) - 接缝位置（历史裁剪章节）与轮组原子性语义
- [rollingSummary.md](./rollingSummary.md) - 可选现货组件（与策略位正交：组件服务会话级持久折叠，不自动接线到策略位）
- [agentErrors.ts](./agentErrors.ts) - 不变量违反抛 `AgentError`
