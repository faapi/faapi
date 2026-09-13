---
"@faapi/task-bullmq": minor
---

feat: 新增 `@faapi/task-bullmq` 子包——faapi 任务子系统的 BullMQ 驱动（Redis 持久化队列）。`createBullMQDriver({ connection, prefix? })` 实现 `TaskDriver`：enqueue → `queue.add`（attempts = retries + 1，指数退避 500ms 起，delay 支持）、startWorker → `new Worker`（concurrency）、stop 关闭 workers + queues。业务方写法不变，`config.task.driver: 'bullmq'` 即启用。
