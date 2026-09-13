---
'@faapi/faapi': minor
'@faapi/task-pgboss': minor
'@faapi/task-bullmq': minor
---

任务队列：幂等投递（dedupId）+ 失败钩子（onFailed）——解决多实例 cron 重复投递

- `enqueue` 新增可选幂等键 `dedupId`：同键任务在队列系统保留期内不重复入队，重复投递返回已存在任务 id。`@faapi/task-bullmq` 映射 `jobId`（BullMQ 原生去重）；`@faapi/task-pgboss` 映射 `send` 自定义 `id`（要求 UUID 格式，驱动内做任意字符串 → SHA-1 确定性 UUID 映射，主键冲突 DO NOTHING 即跳过）
- **cron 投递自动携带幂等键** `cron:<任务名>:<计划触发时刻>`（croner `currentRun()`，秒级）——多 worker 实例同一触发窗算出同键，驱动按键去重只入队一份，修复多实例部署下 cron 重复投递（依赖实例时钟同步，NTP）
- `TaskConfig` 新增 `onFailed({ task, jobId, attempt, willRetry, cancelled, error })`：任务执行失败/取消后触发（含将重试的失败；`willRetry` 按任务 meta.retries 推算，`cancelled` 标记框架终止），用于告警/死信上报等副作用；自身抛错被忽略
- 管理端点保持不内置（内置路由无鉴权是安全陷阱）：`src/task/README.md` 新增受保护目录下的管理 handler 示例（`listQueued`/`cancel`/`retry` 组合）
