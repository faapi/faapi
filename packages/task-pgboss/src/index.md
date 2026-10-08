# createPgBossDriver（pg-boss 驱动）

一句话概括：把 faapi 任务子系统的 `TaskDriver` 接口映射到 pg-boss v12 API（send/work/offWork/stop/findJobs，peer 要求 `^12`），并在投递前确保队列存在。

## 为什么需要

- 主包任务子系统只面向驱动无关的 `TaskDriver` 接口（driverTypes.md），持久化队列能力由本适配层承载。
- pg-boss（v10 起移除 v9 的隐式建队列，v12 同）行为：`send()` 的 INSERT SQL `JOIN queue`，对未创建的队列静默返回 null（不报错）；`work()` 只注册进程内轮询器，同样不建队列。驱动若不显式 `createQueue`，空库上首次 `enqueue` 必然拿到 null——驱动把无 dedupId 的 null 当失败抛错，业务接口 500（生产冷启动必现，dev 因本地库早已有队列而难复现）。
- pg-boss 的 `create_queue` plpgsql 幂等（`ON CONFLICT DO NOTHING`，队列已存在直接返回），驱动在投递前无条件补建队列是安全且便宜的——每个任务名每进程只需一次真实建队列，之后进程内 Set 缓存短路。

## 使用场景

- `config.task.driver: 'pgboss'` 时由主包 `loadTaskDriver` 动态加载本驱动。
- `enqueue`：先 ensureQueue 再 send——覆盖所有投递入口（HTTP handler / cron / `FAAPI_TASKS_DISABLED=1` 只入队不消费的 API 节点，这些节点不走 startWorker）。
- `startWorker`：先 ensureQueue 再 work——应用启动即对任务清单建齐队列，队列对 pg-boss 侧监控/管理工具立即可见。
- `groups`（任务组记账）：同库两张自建表（`faapi_task_groups` 组行 + `faapi_task_group_members` 成员行，首次组操作 `CREATE TABLE IF NOT EXISTS`），经 `boss.getDb().executeSql` 计账——落定为单条 CTE（成员行 settled 守卫翻转 + 计数递增原子，重复落定不重复计数）；成员组标识以载荷包装随 data 存储、交付/查询时还原（业务 payload 不变）；`cancelRemaining` 逐成员 `boss.cancel` 后 `getJobById` 核实真实生效才落定（pg-boss 对不可取消状态静默 no-op）。完整语义见主包 `taskGroups.md`。

## 相关模块

- 主包 `packages/faapi/src/task/driverTypes.ts` —— `TaskDriver` 接口定义与各驱动能力边界
- 主包 `packages/faapi/src/task/taskGroups.md` —— 任务组原语契约（组投递 / 记账 / fan-in / 失败语义）
- 主包 `packages/faapi/src/task/taskQueue.ts` —— 语义层（任务记录 / payload 校验 / 生命周期编排），本层只做驱动映射
- `@faapi/task-bullmq` —— 对照驱动：BullMQ 的 add 隐式建队列，无需 ensureQueue
