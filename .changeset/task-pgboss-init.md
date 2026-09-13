---
"@faapi/task-pgboss": minor
---

feat: 新增 `@faapi/task-pgboss` 子包——faapi 任务子系统的 pg-boss 驱动（PostgreSQL 持久化队列）。`createPgBossDriver(options)` 实现 `TaskDriver`：enqueue → `boss.send`（retryLimit/retryBackoff/startAfter）、startWorker → `boss.work`（batchSize 并发 + includeMetadata）、stop 优雅停机。业务方写法不变，`config.task.driver: 'pgboss'` 即启用。
