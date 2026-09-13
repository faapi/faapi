---
'@faapi/faapi': minor
'@faapi/task-pgboss': minor
'@faapi/task-bullmq': minor
---

任务队列管理能力：TaskClient 新增持久化查询 / 取消 / 重试，TaskDriver 新增可选管理方法

- `TaskClient` 新增 `listQueued(name?)`：持久化队列视图——驱动实现 `TaskDriver.list` 时返回队列侧任务（含其他实例与历史执行），并与本进程执行记录按 id 合并（本进程观测优先）；现有同步 `list(name?)` 保持进程内快照语义不变
- `TaskClient` 新增 `cancel(name, id)` / `retry(name, id)`：取消等待/延迟中的任务、重试失败/取消的任务；本进程有该 id 记录时同步更新状态（cancel → cancelled，retry → pending）
- `TaskDriver` 新增可选方法 `list` / `cancel` / `retry`（返回 `TaskDriverRecord`，状态由子包映射为 faapi 语义）；驱动未实现时调用显式抛错，不静默降级
- `@faapi/task-bullmq` 全部实现：list（waiting/delayed→pending、active→running、completed→done、failed→failed）、cancel=`job.remove()`（BullMQ 无 cancelled 状态，取消即移除）、retry=`job.retry()`（仅 failed）
- `@faapi/task-pgboss` 实现 cancel=`boss.cancel(name, id)`、retry=`boss.resume(name, id)`（仅 cancelled 可恢复）；pg-boss v10 无批量列出 jobs 的公开 API，`list` 未实现——`listQueued` 显式抛错，管理走 pg-boss 自身 API/SQL
