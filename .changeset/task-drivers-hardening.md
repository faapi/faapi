---
'@faapi/task-pgboss': minor
---

任务队列驱动可靠性加固（pg-boss / BullMQ 双驱动）：

- **task-pgboss 批内失败隔离**：`work` handler 批内任务改为并发执行 + 逐任务 `complete`/`fail` 结算（pg-boss 结算 SQL 带 state 守卫，已结算任务对后续批量结算免疫）——单个任务失败只消耗自己的重试额度，不再毒化同批其他任务；`concurrency` 语义与 BullMQ 驱动对齐（此前批内串行执行且无逐任务隔离，第 1 个任务抛错时同批已被 fetch 成 active 的任务也被记失败消耗重试额度）
- **task-pgboss 执行硬限映射**：`enqueue` 按任务元信息映射 `expireInSeconds`（`timeoutMs + graceMs + 60s` 缓冲；未声明 `timeoutMs` 的任务用新增驱动选项 `defaultExpireSeconds` 兜底，默认 24h）——此前未映射，pg-boss DDL 默认 15 分钟硬限会判超时失败并重试仍在后台运行的长任务，同一任务两份并发执行（文档示例 `timeoutMs: 30min` 即踩中）
- **task-pgboss stop 双重失效修复**：`offWork` 与 deadline 竞速（卡死任务此前会让 `queue.stop()` 永久悬挂）；`timeout` 改为毫秒直传（此前 `Math.floor(timeoutMs / 1000)` 把毫秒当秒传，`stop(10s)` 实际只 drain 1 秒即 `failWip` 处置在跑任务）；deadline 到点 abort 在跑任务 signal 的语义不变
- **task-pgboss 进程健壮性**：PgBoss 实例挂 `error` 事件监听（PG 连接池重启/网络闪断此前会成为 uncaughtException 崩进程）；修复 `start` 期间 `stop` 的停机竞态——此前会回写一个已 start、永不 stop 的实例（泄漏 + 停机后仍可消费）
- **task-bullmq attempt 状态源**：改用 `job.attemptsStarted`（BullMQ 维护，首次执行为 1，跨实例/重启准确）——此前进程内 Map 自计数只增不删（长驻进程内存泄漏），多实例共库或进程重启后计数失真；`list` 的 attempts 同步优先取 `attemptsStarted`
- **task-bullmq 终态清理策略**：新增 `removeOnComplete` / `removeOnFail` 驱动选项，默认终态任务 7 天后移除——此前默认永久保留，Redis 无界增长，且 dedupId（jobId）去重在任务存活期内一直生效，周期性复用同一 dedupId 的投递（如 nightly-sync）首次完成后会被永久静默忽略；传 `false` 恢复 BullMQ 默认行为
- **主包配合**：`TaskDriver.enqueue` opts 新增 `timeoutMs` / `graceMs`（语义层从任务 meta 透传，自定义驱动可消费）；`driverTypes.md` 补执行硬限/批内失败隔离/停机语义约定
