---
'@faapi/agent': minor
---

新增历史压缩（compaction）能力——策略位 + 可选现货组件：

- **策略位**：`ReactLoopConfig` / `AgentRuntimeConfig` 新增 `historyCompactor`——`maxHistoryTokens` 超预算且存在轮组时改调业务压缩策略（整体替换现行截断），仅作用于发送副本（`result.messages` 与续跑源不受影响）；子代理递归共享根 deps 全树生效。输出不变量由框架强制守卫（system 与初始 user 头部段必须保留 / `tool_calls` 与 tool 结果按 `tool_call_id` 配对完整 / 至少保留一个轮组），违反抛 `AgentError` 不静默。缺省不声明时逐字节保持现行「按轮组从最旧截断」行为
- **现货组件**：`createRollingSummaryCompactor`——滚动摘要折叠配方（`plan` 折叠计划 / `fold` 摘要合并 / `block` 注入块四件套纪律文案），`complete` 接轻量补全签名；保留条数 / 折叠批次 / 摘要长度 / 提示词全文 / 轮次格式全部可覆盖，组件无状态（折叠状态存储留业务表设计），与策略位正交不自动接线

内部重构：`AgentError` / `AgentRecursionError` / `AgentToolTimeoutError` 迁至 `agentErrors.ts`（reactLoop 的不变量守卫需要抛 `AgentError`，独立模块解循环依赖），经 agent re-export——`from '@faapi/agent'` 导入路径零变化。
