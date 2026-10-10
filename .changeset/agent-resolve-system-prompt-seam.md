---
'@faapi/agent': minor
---

`AgentDeps` 新增可选 `resolveSystemPrompt(name, meta, base)` 装饰钩子——systemPrompt 的解析 seam：框架解析好 base（内联字面量或 `systemPromptFile` 文件内容，语义与现状一致）后调用，返回值即最终 system 消息。组装层得以在框架解析结果之上叠加应用层装饰（共享协议块 / 条件块 / DB 运行时层），替代「包装 `getAgent` / `resolveSubAgents` 访问器 + 预读文件建快照 + 剥除 `systemPromptFile` 声明」三件套机械。每次 run / 派发各调用一次（与文件直读同款新鲜度）；sub-agent 递归复用同一 deps，一次注入覆盖主控与全部可达子代理；钩子抛错原样上抛不吞；base 不可读仍抛 `AgentError`（钩子不被调用）；未声明钩子 = 逐字节现状。框架工厂路径（`@faapi/agent` 插件）暂不透传此钩子，需要装饰的场景走编程式组装（`new Agent(deps)`）。
