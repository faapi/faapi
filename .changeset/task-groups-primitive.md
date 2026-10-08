---
'@faapi/faapi': minor
'@faapi/task-pgboss': minor
'@faapi/task-bullmq': minor
---

任务组原语：切批扇出 / 进度记账 / fan-in 完成判定收编为框架能力（此前三件编排样板全靠业务手搓）

- `TaskClient.enqueueGroup(name, payloads, { groupId?, onComplete?, onFailure?, delayMs? })`：一次投递 N 个同构子任务——payload 全量校验前置（任一失败整组不投递）、成员 dedupId 框架自动派生（`faapi-group:<groupId>:<index>`，替代业务自拼序号）、同 groupId 幂等重投自愈（长任务扇出建议 groupId 从业务键派生，发起任务被重试时重调即天然补投）
- `TaskClient.getGroup(groupId)`：组记账快照（total/done/failed/cancelled/settled/status/completionEnqueued），驱动侧存储跨实例/重启正确
- fan-in：全部成员落定（重试耗尽后的终态）时框架自动入队 `onComplete` 回调任务，payload 为 `TaskGroupSummary` 契约——回调是普通任务（持久化、可重试、独立 meta），入队 dedupId 兜底至多一份；组已落定而回调未入队（宿主在两步之间崩溃）经同 groupId 重投自愈
- 失败语义按组声明 `onFailure`：`'run-to-completion'`（默认，跑完记 partial）/ `'fail-fast'`（首个成员最终失败即取消未落定成员，在跑的自然跑完）
- `TaskContext.tasks` / `IsolatedTaskContext.tasks` 必有字段：任务内扇出不绕 `getApp()`——进程内活引用，隔离路径全方法 postMessage RPC 代理回宿主执行（参数与返回值须可结构化克隆，与 progress/log 同口径）
- `TaskDriver.groups`（可选能力，`TaskDriverGroupOps`：create/settle/unsettle/markCompletionEnqueued/get/cancelRemaining）：驱动未实现时 enqueueGroup/getGroup 显式抛错；`enqueue` 新增 `opts.groupId`、`TaskDriverJob`/`TaskDriverRecord` 新增 `groupId`（成员组标识以驱动内部载荷包装传输，业务 payload 不变）
- `@faapi/task-pgboss`：组记账落同库两张表（`faapi_task_groups`/`faapi_task_group_members`，首次组操作自建），落定为单条 CTE 原子计账
- `@faapi/task-bullmq`：组记账落两组 Redis hash（`<prefix>:group:<id>`/`<prefix>:group-members:<id>`），经 `defineCommand`/`runCommand` Lua 原子计账，专用连接复用连接池

切分策略（按什么切、每批多大）与业务自有进度指标是业务知识，不在框架范围。完整语义与已声明边界见 `packages/faapi/src/task/taskGroups.md`。
