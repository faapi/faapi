---
'@faapi/task-pgboss': minor
'@faapi/task-bullmq': minor
---

队列驱动升级上游 major：pg-boss `^10` → `^12`、BullMQ `^5` → `^6`：

- **pg-boss 12**：业务方需安装 `pg-boss@^12`。驱动适配三处上游变化——命名导出（v10 的 `import PgBoss from 'pg-boss'` 改为 `{ PgBoss }`）、`offWork` 签名（v12 为 `offWork(name, { id })`，队列名升为第一参数，驱动 stop/reload 路径同步修正——v10 的 `offWork(workerId)` 传法在 v12 下语义错误）、类型面改顶层导出（`ConstructorOptions`/`SendOptions` 不再经 `PgBoss` 命名空间）
- **BullMQ 6**：业务方需安装 `bullmq@^6` 并**显式安装 `ioredis`**（bullmq 6 起 ioredis 由内置依赖移至 peer dependency，bullmq 5 时代无需）——README 安装说明已更新；驱动 API 面（Queue/Worker/getJobs/close）在 v6 类型兼容，无代码改动
- **pg-boss 12.28 起放宽 expire 断言**（允许恰好 24h）：驱动的 86399 兜底与主包 `timeoutMs` 23h 上限保持不变——保守值对全部 pg-boss 12 小版本安全，且保持跨驱动统一预算口径；相关注释与文档同步为准确表述
- pg-boss v10 时代的"无批量列出 API"能力缺口在上游已补（v12 `findJobs`）：驱动 `list` 实现留作后续，`listQueued` 维持显式抛错不静默降级
