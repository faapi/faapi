---
'@faapi/agent': minor
'@faapi/faapi': minor
---

新增 `<system-reminder>` 风格上下文注入（reminders），同时支持全局与单 agent 两个声明面。全局面 `config.agent.reminders?: ReminderSpec[]`（`ReminderSpec = string | ReminderBuilder | { when?: 'once' | 'everyTurn'; content: string | ReminderBuilder }`，支持动态函数）；单 agent 面为 agent config 块的 `reminders?: string[]`（构建期字面量提取，全部静态固定）。两通道语义：`once` 在全新 run（无 `options.messages`）时渲染一次并持久写进循环历史（受裁剪/压缩影响、续跑不重注入），`everyTurn` 在每轮 LLM 请求前追加到发送副本末条 user 消息（不进本地历史、不占预算）；string 默认 once、函数默认 everyTurn、对象形式显式 `when` 覆盖。合并顺序全局在前、单 agent 在后；每条各自包裹为 `<system-reminder>\n…\n</system-reminder>` 块并以空行连接，空串/undefined 跳过。新增 deps 级钩子 `AgentDeps.resolveReminders`（接线时整体取代本地声明，避免双渲染），隔离任务路径经 `resolve-reminders` RPC 回宿主全量渲染（ctx 不跨线程）；`AgentToolRunner` 同步新增 `resolveReminders`。builder 抛错/返回类型违约/spec 形态违约均 fail fast 抛 `AgentError`（带 agentName/phase/spec 序号与 cause）。
