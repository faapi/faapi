---
'@faapi/agent': minor
---

`AgentDeps` 新增 `resolveSubAgentInput` 派发入参改写钩子：`executeSubAgent` 在派发入参校验（富 schema 模式 zod validate）之后、user 消息构造之前以 `(subName, args, ctx)` 异步调用——返回普通对象**整体替换**派发 args，改写结果经 `extractSubAgentUserInput` 构造子代理首条 user 消息（交接单附件通道：服务端按 agent 材料清单预取的设定/大纲/参考包拼进 user 消息，不污染身份/纪律所在的 system），并传导给 `resolveSubAgentContext` 供数与 `afterToolCall` 审计（同一份最终 args 全链一致）。改写结果不受 Input schema 约束（合成材料字段无需声明进 `Input`，主控可见派发 schema 保持干净）；`undefined` 原样放行；返回非法形状（null/数组/原始值）抛 `AgentError` 显式失败；抛错原样上抛被 per-tool catch 回灌主控 LLM。未声明钩子行为逐字节不变，与 `resolveSubAgentContext`（system 追加通道）职责正交、可并存。流式/非流式父循环同一接线。细则见 `packages/agent/src/agent.md`「resolveSubAgentInput 派发入参改写钩子」。
