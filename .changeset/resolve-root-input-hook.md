---
'@faapi/agent': minor
---

Agent 新增根调用输入组装钩子 `resolveRootInput`（AgentDeps 级，与 `resolveSubAgentInput` 派发入参改写钩子对偶）：根调用（`run`/`stream` 顶层，depth 1）传入非空 `input` 时在 run 入口调用，返回字符串整体替换本次 user 输入，组装产物作为本次 run 的 user 消息进循环历史并随 `result.messages` / `done.messages` 导出（业务侧落库、续跑链继承、前端渲染全链可见）；`undefined` 原样放行，非非空字符串（null/数字/对象/空串/空白串）抛 `AgentError` fail fast。派发路径（depth ≥ 2）不触发——派发侧组装仍归 `resolveSubAgentInput`，两者互斥不叠加；纯续跑（messages + 无 input）不触发。纯插槽原语：块语义/顺序/收尾形态全是业务决策，框架统一「何时调用」与「产物去向」，不收编内容（与 7.5.0「滚动摘要交还业务侧」分层取向一致）。未声明钩子 = 现状逐字节。
