---
'@faapi/faapi': minor
---

移除任务队列内置 memory 驱动，任务队列必须由持久化驱动承载：

- 删除内置 memory 驱动及公开导出 `createMemoryDriver`
- `config.task.driver` 取值变为 `'pgboss' | 'bullmq'`（或编程式传入自定义 TaskDriver 实例）；`'memory'` 与未配置时显式抛错
- 存在任务清单（`src/tasks/` 下的 task.ts）时必须显式配置 `config.task.driver`，否则 `createAppBase` 启动报错；无任务清单的项目不加载驱动（内部 `idleTaskDriver` 占位，无需安装驱动子包）
- `TaskConfig` 新增 `pgboss` / `bullmq` 驱动选项字段（透传给对应子包），并新增类型导出 `TaskConfig` / `TaskPgBossOptions` / `TaskBullMqOptions`

迁移方式：安装 `@faapi/task-pgboss`（Postgres）或 `@faapi/task-bullmq`（Redis），在 `faapi.config.ts` 配置 `task.driver` 与对应连接选项。
