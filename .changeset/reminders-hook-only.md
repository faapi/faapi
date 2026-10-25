---
'@faapi/faapi': minor
'@faapi/agent': minor
---

**reminders 概念整线移除（含 `resolveReminders` 钩子与注入引擎）**

业务方反馈（TODO-faapi-gaps 2026-10-26）初版方案为「收敛为钩子唯一入口」；维护者复核后定性 reminder 作为框架原语不够通用——「新鲜且持久进历史」的动态注入由 `resolveRootInput` / `resolveSubAgentInput` 对偶钩子承接（产物随 `result.messages` / `done.messages` 导出），每轮新鲜提醒的诉求与输入组装同源，不值得独立原语。经维护者决策整线删除。

> 版本策略留痕：本变更按语义属破坏性（公开导出与 deps 钩子删除），经维护者指示以 minor 随 7.x 线发布——破坏性影响面为零（业务方全库零存量使用，声明面消费方不存在）。

- **删除**：`@faapi/agent` 的 `AgentDeps.resolveReminders` 钩子与注入引擎（`reminders.ts` 整个模块——`ReminderResolver` / `ResolveRemindersHook` / `joinReminderBlocks` / `createHookReminderResolver`）、reactLoop 的 once / everyTurn 注入通道（`ReactLoopConfig.reminders`）
- **删除**：主包 `ReminderPhase` / `ReminderInfo` 公开导出类型（spec 声明面 `config.agent.reminders`、agent config 块 `reminders` 字段与 `ReminderSpec` 类型族同批移除）
- **迁移守卫**：agent config 块声明 `reminders` 字段即撞未知字段白名单报错（启动期）
- **迁移指引**：进历史的动态注入块（落库 / 前端渲染 / 续跑链继承）走 `resolveRootInput`（根调用）/ `resolveSubAgentInput`（派发）；每轮新鲜提醒在 `resolveRootInput` 内按业务节奏组装或自建每轮逻辑
- 隔离任务 e2e 的钩子宿主生效验证改走 `resolveRootInput` 载体（行为覆盖不缩水）
