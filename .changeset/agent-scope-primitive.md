---
'@faapi/agent': minor
---

新增执行作用域原语（`getAgentScope`）：run/stream 全链上业务任何深层（tool 内部的 DAO、审计层、成本分摊层）可读「当前跑在哪个 agent、第几层」——`AgentScope = { agentName, depth }`（depth 1 = 根 agent），非 agent 执行链（普通 API / cron / 直调 reactLoop）返回 `undefined`。AsyncLocalStorage 实现，作用域由框架在结构正确的位置自动维护：`Agent.run`/`stream` 入口建 store，sub 换栈经 `executeSubAgent` → sub Agent 的 run/stream 委托链统一发生——并发分支（非流式同轮 `Promise.all` 多派发）各自作用域，归属互不串，不依赖任何「流式同轮串行」的实现细节。纯读取上下文：不改任何执行语义，不读 = 零行为变化；与 `enableTracing` 正交（常开轻量上下文 vs opt-in 明细事件），无配置面（业务只读）。语义契约见 `packages/agent/src/agentScope.md`。
