# @faapi/task-bullmq

## 6.18.0

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

- 9874ebb: feat: 新增 `@faapi/task-bullmq` 子包——faapi 任务子系统的 BullMQ 驱动（Redis 持久化队列）。`createBullMQDriver({ connection, prefix? })` 实现 `TaskDriver`：enqueue → `queue.add`（attempts = retries + 1，指数退避 500ms 起，delay 支持）、startWorker → `new Worker`（concurrency）、stop 关闭 workers + queues。业务方写法不变，`config.task.driver: 'bullmq'` 即启用。
