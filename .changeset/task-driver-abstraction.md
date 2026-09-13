---
"@faapi/faapi": minor
---

feat(task): 任务队列驱动抽象——存储/消费/重试/停机拆分为 `TaskDriver` 接口（`driverTypes.ts`），原内存队列逻辑下沉为默认 `memoryDriver`（行为不变）；`config.task.driver` 支持 `'pgboss'` / `'bullmq'`（动态加载 `@faapi/task-pgboss` / `@faapi/task-bullmq` 子包，未安装显式报错）与自定义 `TaskDriver` 实例；dev `reloadTasks` 改为 `queue.reload()` 重注册 worker（驱动连接保持）。持久化驱动下任务不丢、多实例防重跑由队列系统保证。
