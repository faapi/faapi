---
'@faapi/task-pgboss': minor
---

task-pgboss 新增 `list` 能力（pg-boss v12 `findJobs`，升级 `^12` 后解锁）：

- 六态精确映射：created→pending、retry→retry、active→running、completed→done、failed→failed、cancelled→cancelled——pg-boss 可区分重试等待与延迟投递，比 BullMQ 驱动（delayed 无法区分，统一归 pending）更精确；`cancelled` 可查（BullMQ 取消即移除，无此状态）
- 不传 `name` 时遍历本进程已 `ensureQueue` 的任务名（与 BullMQ 驱动遍历已建 Queue 实例同语义）；`FindJobsOptions` 无 state/limit 过滤，映射后自行过滤 + `createdAt` 降序截断 `limit`（默认 50）
- `attempts` = `retryCount + 1`（与执行路径 attempt 口径一致）；`runAt` 取 `startAfter`（计划执行时间）；驱动 `complete()` 不携带执行结果，done 记录无 `result`；failed 记录 `error` 从 `output` 提取（`{ message }` / `{ value }` 结算形态，提取不到不放字段）
- `TaskClient.listQueued` 对 pgboss 驱动随之可用（此前显式抛错）——队列侧记录与本进程记录按 id 合并、本进程观测优先
