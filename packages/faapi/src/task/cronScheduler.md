# cronScheduler

一句话概括：为声明了 `cron` 元信息的任务建立定时器，到点自动调用 `enqueue(name, { dedupId })`（空 payload + 幂等键），复用同一队列。

## 为什么需要

定时任务是异步任务的高频触发源。把 cron 实现为"自动投递者"而非独立执行器，队列的重试/并发/优雅停机语义天然复用，只维护一套执行模型。

## 使用场景

- `createAppBase` 启动队列时一并启动；`stop` 时停止全部定时器
- dev `reloadTasks` 后随队列重新读取任务 meta（新增/删除 cron 任务自动生效）

## 行为约定

- cron 表达式用 croner 解析（支持秒级）；启动时解析失败（非法表达式）直接抛错，不静默跳过
- 到点投递空 payload `{}`——cron 任务应声明无参 `run` 或给 Payload 全可选字段
- **多实例防重**：投递携带幂等键 `dedupId = cron:<任务名>:<计划触发时刻 ISO>`（croner `currentRun()`，秒级计划时刻）——N 个实例同一触发窗算出同键，驱动按 dedupId 去重（pgboss 自定义 job id 主键冲突跳过；BullMQ jobId 去重），只入队一份。依赖实例间时钟同步（NTP）；时钟偏差跨过计划时刻边界的实例仍可能各自入队。**dedupId 映射随驱动能力不同，见 driverTypes.md**
- `stop()` 停止全部定时器，重复调用幂等

## 相关模块

- `src/task/taskQueue.ts` — enqueue
- `src/task/taskRegistry.ts` — 遍历带 cron 的任务
- 依赖：`croner`（新增 dependencies）
