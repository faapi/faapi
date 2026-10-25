---
'@faapi/faapi': major
'@faapi/agent': major
---

**reminders spec 声明面整线移除——`resolveReminders` 钩子收敛为唯一入口**

移除（声明即撞 config 白名单报错，充当迁移守卫）：

- 全局声明面 `config.agent.reminders`（`AgentConfig.reminders` 字段）
- 单 agent config 块 `reminders` 字段（`AgentDeclaration` / `AgentCore.reminders`）及其启动期校验
- `ReminderSpec` / `ReminderSpecObject` / `ReminderBuilder` 公开导出类型及 spec 渲染器（`reminderPhaseOf` / `renderReminderSpecs` / `createSpecReminderResolver` / `collectReminderSpecs`）

保留（引擎双通道语义不变）：`resolveReminders` deps 级钩子（`createAgentDeps` overrides / `config.agent.decorateDeps` 接线）与 once（首轮持久进历史）/ everyTurn（每轮刷新发送副本）注入通道、`<system-reminder>` 统一包裹与空渲染跳过、sub-agent 派发注入时序。钩子契约类型 `ReminderPhase` / `ReminderInfo` 继续从 `@faapi/faapi` 导出。

顺手收紧（钩子路径防护拉齐原 spec 路径水准）：钩子抛错包 `AgentError`（含 agent 名与 phase，`{ cause }` 保留原始错误）；返回值非 `string[]`（非数组或数组含非 string 元素）显式抛 `AgentError`，不再于 `contents.map` 处炸晦涩 TypeError 或把坏值静默渲染进提醒块。

迁移指引：「新鲜且持久进历史」的动态注入块走 `resolveRootInput`（根调用）/ `resolveSubAgentInput`（派发）；「不进历史本体的每轮新鲜提醒」走 `resolveReminders` 钩子。隔离任务快照投影（`AgentSnapshotRecord`）同步删除 reminders 剥离逻辑（字段不复存在）。
