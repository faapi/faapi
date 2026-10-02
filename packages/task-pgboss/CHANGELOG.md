# @faapi/task-pgboss

## 6.27.0

## 6.26.0

### Minor Changes

- 0889151: task-pgboss 新增 `list` 能力（pg-boss v12 `findJobs`，升级 `^12` 后解锁）：

  - 六态精确映射：created→pending、retry→retry、active→running、completed→done、failed→failed、cancelled→cancelled——pg-boss 可区分重试等待与延迟投递，比 BullMQ 驱动（delayed 无法区分，统一归 pending）更精确；`cancelled` 可查（BullMQ 取消即移除，无此状态）
  - 不传 `name` 时遍历本进程已 `ensureQueue` 的任务名（与 BullMQ 驱动遍历已建 Queue 实例同语义）；`FindJobsOptions` 无 state/limit 过滤，映射后自行过滤 + `createdAt` 降序截断 `limit`（默认 50）
  - `attempts` = `retryCount + 1`（与执行路径 attempt 口径一致）；`runAt` 取 `startAfter`（计划执行时间）；驱动 `complete()` 不携带执行结果，done 记录无 `result`；failed 记录 `error` 从 `output` 提取（`{ message }` / `{ value }` 结算形态，提取不到不放字段）
  - `TaskClient.listQueued` 对 pgboss 驱动随之可用（此前显式抛错）——队列侧记录与本进程记录按 id 合并、本进程观测优先

- e35ad13: 队列驱动升级上游 major：pg-boss `^10` → `^12`、BullMQ `^5` → `^6`：

  - **pg-boss 12**：业务方需安装 `pg-boss@^12`。驱动适配三处上游变化——命名导出（v10 的 `import PgBoss from 'pg-boss'` 改为 `{ PgBoss }`）、`offWork` 签名（v12 为 `offWork(name, { id })`，队列名升为第一参数，驱动 stop/reload 路径同步修正——v10 的 `offWork(workerId)` 传法在 v12 下语义错误）、类型面改顶层导出（`ConstructorOptions`/`SendOptions` 不再经 `PgBoss` 命名空间）
  - **BullMQ 6**：业务方需安装 `bullmq@^6` 并**显式安装 `ioredis`**（bullmq 6 起 ioredis 由内置依赖移至 peer dependency，bullmq 5 时代无需）——README 安装说明已更新；驱动 API 面（Queue/Worker/getJobs/close）在 v6 类型兼容，无代码改动
  - **pg-boss 12.28 起放宽 expire 断言**（允许恰好 24h）：驱动的 86399 兜底与主包 `timeoutMs` 23h 上限保持不变——保守值对全部 pg-boss 12 小版本安全，且保持跨驱动统一预算口径；相关注释与文档同步为准确表述
  - pg-boss v10 时代的"无批量列出 API"能力缺口在上游已补（v12 `findJobs`）：驱动 `list` 实现留作后续，`listQueued` 维持显式抛错不静默降级

## 6.25.0

## 6.24.0

## 6.23.0

## 6.22.0

## 6.21.1

## 6.21.0

## 6.20.0

## 6.19.0

## 6.18.1

### Patch Changes

- abb079a: 修复未声明 `timeoutMs` 的任务入队必抛 AssertionError：过期预算默认值 24h 整踩中 pg-boss 10 的排他上界断言（`expireIn/3600 < 24`），`send()` 在参数校验阶段即拒绝。默认值改为 24h − 1s（86399 秒），语义不变（仍是约一天的执行预算兜底），`defaultExpireSeconds` 的 JSDoc 与 README 注明上界为排他——显式配置 >= 86400 会被 pg-boss 拒绝

## 6.18.0

### Minor Changes

- 5f7a69a: 任务队列驱动可靠性加固（pg-boss / BullMQ 双驱动）：

  - **task-pgboss 批内失败隔离**：`work` handler 批内任务改为并发执行 + 逐任务 `complete`/`fail` 结算（pg-boss 结算 SQL 带 state 守卫，已结算任务对后续批量结算免疫）——单个任务失败只消耗自己的重试额度，不再毒化同批其他任务；`concurrency` 语义与 BullMQ 驱动对齐（此前批内串行执行且无逐任务隔离，第 1 个任务抛错时同批已被 fetch 成 active 的任务也被记失败消耗重试额度）
  - **task-pgboss 执行硬限映射**：`enqueue` 按任务元信息映射 `expireInSeconds`（`timeoutMs + graceMs + 60s` 缓冲；未声明 `timeoutMs` 的任务用新增驱动选项 `defaultExpireSeconds` 兜底，默认 24h）——此前未映射，pg-boss DDL 默认 15 分钟硬限会判超时失败并重试仍在后台运行的长任务，同一任务两份并发执行（文档示例 `timeoutMs: 30min` 即踩中）
  - **task-pgboss stop 双重失效修复**：`offWork` 与 deadline 竞速（卡死任务此前会让 `queue.stop()` 永久悬挂）；`timeout` 改为毫秒直传（此前 `Math.floor(timeoutMs / 1000)` 把毫秒当秒传，`stop(10s)` 实际只 drain 1 秒即 `failWip` 处置在跑任务）；deadline 到点 abort 在跑任务 signal 的语义不变
  - **task-pgboss 进程健壮性**：PgBoss 实例挂 `error` 事件监听（PG 连接池重启/网络闪断此前会成为 uncaughtException 崩进程）；修复 `start` 期间 `stop` 的停机竞态——此前会回写一个已 start、永不 stop 的实例（泄漏 + 停机后仍可消费）
  - **task-bullmq attempt 状态源**：改用 `job.attemptsStarted`（BullMQ 维护，首次执行为 1，跨实例/重启准确）——此前进程内 Map 自计数只增不删（长驻进程内存泄漏），多实例共库或进程重启后计数失真；`list` 的 attempts 同步优先取 `attemptsStarted`
  - **task-bullmq 终态清理策略**：新增 `removeOnComplete` / `removeOnFail` 驱动选项，默认终态任务 7 天后移除——此前默认永久保留，Redis 无界增长，且 dedupId（jobId）去重在任务存活期内一直生效，周期性复用同一 dedupId 的投递（如 nightly-sync）首次完成后会被永久静默忽略；传 `false` 恢复 BullMQ 默认行为
  - **主包配合**：`TaskDriver.enqueue` opts 新增 `timeoutMs` / `graceMs`（语义层从任务 meta 透传，自定义驱动可消费）；`driverTypes.md` 补执行硬限/批内失败隔离/停机语义约定

## 6.17.0

## 6.16.0

## 6.15.0

## 6.14.0

## 6.13.0

## 6.12.0

## 6.11.0

## 6.10.1

## 6.10.0

## 6.9.1

## 6.9.0

## 6.8.0

## 6.7.0

## 6.6.0

## 6.5.0

## 6.4.1

### Patch Changes

- fbe369a: 修复 enqueue 对未创建队列抛 "pg-boss send failed"：pg-boss v10 不再隐式建队列（send 对未创建队列静默返回 null，work 也不建队列）。驱动现在在投递（enqueue）与注册 worker（startWorker）前自动幂等 createQueue（create_queue plpgsql ON CONFLICT DO NOTHING，已存在直接返回），每任务名每进程一次、进程内缓存短路、并发投递去重；空库冷启动首次 enqueue 不再 500。业务方此前在 onReady 中按任务清单手工 createQueue 的变通逻辑可移除。

  另修复启动时序：`createAppBase` 现在 await 任务队列启动——listen 前 worker 注册/队列创建已就绪（此前 `taskQueue.start()` 是浮动 promise，冷启动首次 enqueue 可能早于 worker 注册投递，驱动启动失败还会变成 unhandled rejection）；驱动启动失败（队列库不可达等）时 createAppBase 直接 reject，端口不暴露（fail fast）。驱动侧 `ensureBoss` 并发首调共享同一次 `boss.start()`（半启动实例不外借），start 失败坏实例不入缓存可重试。

## 6.4.0

### Minor Changes

- 1906749: 任务队列：幂等投递（dedupId）+ 失败钩子（onFailed）——解决多实例 cron 重复投递

  - `enqueue` 新增可选幂等键 `dedupId`：同键任务在队列系统保留期内不重复入队，重复投递返回已存在任务 id。`@faapi/task-bullmq` 映射 `jobId`（BullMQ 原生去重）；`@faapi/task-pgboss` 映射 `send` 自定义 `id`（要求 UUID 格式，驱动内做任意字符串 → SHA-1 确定性 UUID 映射，主键冲突 DO NOTHING 即跳过）
  - **cron 投递自动携带幂等键** `cron:<任务名>:<计划触发时刻>`（croner `currentRun()`，秒级）——多 worker 实例同一触发窗算出同键，驱动按键去重只入队一份，修复多实例部署下 cron 重复投递（依赖实例时钟同步，NTP）
  - `TaskConfig` 新增 `onFailed({ task, jobId, attempt, willRetry, cancelled, error })`：任务执行失败/取消后触发（含将重试的失败；`willRetry` 按任务 meta.retries 推算，`cancelled` 标记框架终止），用于告警/死信上报等副作用；自身抛错被忽略
  - 管理端点保持不内置（内置路由无鉴权是安全陷阱）：`src/task/README.md` 新增受保护目录下的管理 handler 示例（`listQueued`/`cancel`/`retry` 组合）

- 0d88231: 任务队列管理能力：TaskClient 新增持久化查询 / 取消 / 重试，TaskDriver 新增可选管理方法

  - `TaskClient` 新增 `listQueued(name?)`：持久化队列视图——驱动实现 `TaskDriver.list` 时返回队列侧任务（含其他实例与历史执行），并与本进程执行记录按 id 合并（本进程观测优先）；现有同步 `list(name?)` 保持进程内快照语义不变
  - `TaskClient` 新增 `cancel(name, id)` / `retry(name, id)`：取消等待/延迟中的任务、重试失败/取消的任务；本进程有该 id 记录时同步更新状态（cancel → cancelled，retry → pending）
  - `TaskDriver` 新增可选方法 `list` / `cancel` / `retry`（返回 `TaskDriverRecord`，状态由子包映射为 faapi 语义）；驱动未实现时调用显式抛错，不静默降级
  - `@faapi/task-bullmq` 全部实现：list（waiting/delayed→pending、active→running、completed→done、failed→failed）、cancel=`job.remove()`（BullMQ 无 cancelled 状态，取消即移除）、retry=`job.retry()`（仅 failed）
  - `@faapi/task-pgboss` 实现 cancel=`boss.cancel(name, id)`、retry=`boss.resume(name, id)`（仅 cancelled 可恢复）；pg-boss v10 无批量列出 jobs 的公开 API，`list` 未实现——`listQueued` 显式抛错，管理走 pg-boss 自身 API/SQL

- d894267: 任务队列新增超时取消能力（真终止）：

  - `FaapiTaskMeta` 新增 `timeoutMs`：任务声明 `task.timeoutMs` 后在独立 worker 线程执行，超时两段式取消——先 abort 信号给任务优雅退出（宽限 5s），未退出 `terminate()` 硬杀。Node 主线程无法强杀协程，进程内"不再等待"式超时是假取消（控制侧记失败、重试已投递，旧协程仍在跑）；隔离执行保证判定超时即执行真正终止
  - 隔离任务边界：worker 冷启动开销、模块级状态每次执行独立、`taskCtx.config` 为可克隆纯数据快照、返回值须可结构化克隆
  - 任务记录新增 `cancelled` 状态：执行被框架终止（超时终止/停机取消）记 `cancelled`（隔离执行器 reject `TaskCancelledError` 或 job.signal 已 abort），与 run 自身失败的 `failed` 分流，`tasks.list()` 可区分"被取消"与"出错"；两者都交驱动按 retries 重试
  - 驱动子包（@faapi/task-pgboss / @faapi/task-bullmq）：`stop` 超时后 abort 在跑任务的 signal——停机时任务可感知退出（此前信号永不触发），进程退出兜底终止

  未声明 `timeoutMs` 的任务行为不变（进程内执行，零开销）。

## 6.3.0

### Minor Changes

- 9874ebb: feat: 新增 `@faapi/task-pgboss` 子包——faapi 任务子系统的 pg-boss 驱动（PostgreSQL 持久化队列）。`createPgBossDriver(options)` 实现 `TaskDriver`：enqueue → `boss.send`（retryLimit/retryBackoff/startAfter）、startWorker → `boss.work`（batchSize 并发 + includeMetadata）、stop 优雅停机。业务方写法不变，`config.task.driver: 'pgboss'` 即启用。
