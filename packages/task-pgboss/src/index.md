# createPgBossDriver（pg-boss 驱动）

一句话概括：把 faapi 任务子系统的 `TaskDriver` 接口映射到 pg-boss v12 API（send/work/offWork/stop/findJobs，peer 要求 `^12`），并在投递前确保队列存在。

## 为什么需要

- 主包任务子系统只面向驱动无关的 `TaskDriver` 接口（driverTypes.md），持久化队列能力由本适配层承载。
- pg-boss（v10 起移除 v9 的隐式建队列，v12 同）行为：`send()` 的 INSERT SQL `JOIN queue`，对未创建的队列静默返回 null（不报错）；`work()` 只注册进程内轮询器，同样不建队列。驱动若不显式 `createQueue`，空库上首次 `enqueue` 必然拿到 null——驱动把无 dedupId 的 null 当失败抛错，业务接口 500（生产冷启动必现，dev 因本地库早已有队列而难复现）。
- pg-boss 的 `create_queue` plpgsql 幂等（`ON CONFLICT DO NOTHING`，队列已存在直接返回），驱动在投递前无条件补建队列是安全且便宜的——每个任务名每进程只需一次真实建队列，之后进程内 Set 缓存短路。
- 批量行的 `payloads` / `carry` 是 jsonb 列，经 `executeSql` 绑定时驱动**先 `JSON.stringify` 成 JSON 文本再绑参**（缺省保持 SQL NULL）：node-pg 的 `prepareValue` 对普通对象自动 JSON 化，但对顶层数组输出 PG 数组字面量（`{"{…}","{…}"}`，元素是 JSON 串而整体不是 JSON），jsonb 列解析直接 22P02——序列清单恒为数组，裸绑必炸。同 id 重投的幂等比对按**结构深比对**（对象键序无关）：PG jsonb 存储会按自身规则重排对象键序，读回与声明逐字节比较会把同参重投误判为"形状漂移"。

## 使用场景

- `config.task.driver: 'pgboss'` 时由主包 `loadTaskDriver` 动态加载本驱动。
- `enqueue`：先 ensureQueue 再 send——覆盖所有投递入口（HTTP handler / cron / `FAAPI_TASKS_DISABLED=1` 只入队不消费的 API 节点，这些节点不走 startWorker）。
- `startWorker`：先 ensureQueue 再 work——应用启动即对任务清单建齐队列，队列对 pg-boss 侧监控/管理工具立即可见。
- `groups`（批量记账）：同库两张自建表（`faapi_task_groups` 批量行 + `faapi_task_group_members` 成员行，首次组操作 `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS` 幂等迁移批量扩展列 mode/next_index/payloads/carry/member_index，存量行 DEFAULT 'parallel' 语义兼容），经 `boss.getDb().executeSql` 计账——落定为单条 CTE（成员行 settled 守卫翻转 + 计数递增 + serial 激活指针推进原子，重复落定不重复计数）；成员批量标识与序号以载荷包装随 data 存储、交付/查询时还原（业务 payload 不变）；`cancelRemaining`（parallel fail-fast）逐成员 `boss.cancel` 后 `getJobById` 核实真实生效才落定（pg-boss 对不可取消状态静默 no-op）；`settleRemaining`（serial fail-fast）按计数差值补齐落定。完整语义见主包 `taskBatch.md`。

## 相关模块

- 主包 `packages/faapi/src/tasks/driverTypes.ts` —— `TaskDriver` 接口定义与各驱动能力边界
- 主包 `packages/faapi/src/tasks/taskBatch.md` —— 批量任务原语契约（串行有序 / 并行无序 / 记账 / fan-in / 失败语义）
- 主包 `packages/faapi/src/tasks/taskQueue.ts` —— 语义层（任务记录 / payload 校验 / 生命周期编排），本层只做驱动映射
- `@faapi/task-bullmq` —— 对照驱动：BullMQ 的 add 隐式建队列，无需 ensureQueue
