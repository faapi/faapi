# driverTypes

一句话概括：任务队列驱动抽象——语义层（校验/模块加载/记录）与存储调度层（入队/消费/重试/停机）的边界接口，外加可选的持久化管理能力（查询/取消/重试）。

## 为什么需要

任务队列要接入 pg-boss / BullMQ 等外部队列系统，必须把"换存储"限制在驱动边界内。抽出 TaskDriver 后：换驱动 = 换存储，业务方仍用文件约定任务 + `tasks.enqueue`，重启丢任务/多实例防重跑由外部驱动天然解决。框架不内置任何驱动实现——驱动由独立子包或业务方自定义提供。

## 使用场景

- 业务方 `config.task.driver: 'pgboss' | 'bullmq'`（子包提供）或传入自定义 TaskDriver 实例
- 子包 `@faapi/task-pgboss` / `@faapi/task-bullmq` 实现此接口

## 约定

- 重试策略在**入队时**由语义层传 `retries`（从任务 meta 取），驱动负责执行（pg-boss：retryLimit/retryBackoff；bullmq：attempts/backoff）
- `process` 抛错 = 本次执行失败，驱动决定是否重试；语义层在每次 process 调用中更新任务记录（attempt/done/failed）
- `dedupId`（可选，幂等键）：同键任务在队列系统保留期内不重复入队——pgboss 映射 `send` 的自定义 `id`（**要求 UUID 格式，驱动内做任意字符串 → 确定性 UUID（SHA-1）映射**，主键冲突 DO NOTHING 即跳过投递）；bullmq 映射 `jobId`（waiting/active 等存活期内同键忽略）。cron 投递自动携带（见 cronScheduler.md）
- `stop(timeoutMs)` 停消费等 in-flight，**超时后 abort 在跑任务的 signal**（任务监听可尽快退出；进程退出兜底终止），子包 pgboss/bullmq 均已实现；`stopWorkers()` 仅停消费不断连接（dev 热替换重注册用，可选实现）

## 可选管理方法（`list` / `cancel` / `retry`）

- 全部可选——驱动按队列系统的真实能力实现，未实现时 `TaskClient` 对应调用显式抛错（不静默降级）
- `list(opts?)`：查询持久化队列任务，返回 `TaskDriverRecord[]`（status 由子包从队列系统状态映射为 faapi 语义：pgboss created→pending、active→running、completed→done、cancelled→cancelled；bullmq waiting/delayed→pending、active→running、completed→done、failed→failed）。**pg-boss v10 无批量列出 jobs 的公开 API，未实现**（可用 `getJobById`/SQL 旁路）；**BullMQ 取消 = `job.remove()`，移除后记录不可查（无 cancelled 状态）**
- `cancel(name, id)`：取消队列侧任务——pgboss 映射 `boss.cancel`（保留 cancelled 记录）；bullmq 映射 `job.remove()`（等待/延迟中的不再执行，active 受锁限制由 BullMQ 抛错）
- `retry(name, id)`：重试失败/取消的任务——pgboss 映射 `boss.resume`（仅 cancelled 任务可恢复）；bullmq 映射 `job.retry()`（仅 failed 可重试，其余状态由 BullMQ 抛错）
- 语义层补充：`TaskClient.listQueued` 把驱动记录与本进程执行记录按 id 合并（本进程观测优先——attempts/status/result 更实时）

## 相关模块

- `src/task/loadTaskDriver.ts` — 按 config.task.driver 动态加载子包驱动
- `src/task/idleTaskDriver.ts` — 无任务清单时的占位实现
- `src/task/taskWorker.ts` — 隔离执行器（timeoutMs 任务的真终止能力）
- `src/task/taskQueue.ts` — 语义层消费方
