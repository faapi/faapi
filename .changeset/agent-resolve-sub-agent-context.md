---
'@faapi/agent': minor
---

新增 `AgentDeps.resolveSubAgentContext` 派发上下文钩子：`executeSubAgent` 在派发入参校验通过后调用，返回值由框架追加进子代理最终 system 消息（`resolveSystemPrompt` 链路结果之后，`\n\n` 分隔，`undefined`/空串跳过）——补上「按本次派发参数异步取数并送达子代理」的接缝（如按业务 id 查库把数据快照注入子代理 systemPrompt）。`subName` 为真实 agent 名（非派发名），每次派发独立子 Agent 实例注入（同轮并行派发无交叉），抛错走 per-tool 错误链回灌主控 LLM，deps 全树传导，流式/非流式一致；未接线时行为逐字节不变。
