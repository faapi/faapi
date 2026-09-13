---
'@faapi/faapi': minor
'@faapi/task-pgboss': minor
'@faapi/task-bullmq': minor
---

任务队列新增超时取消能力（真终止）：

- `FaapiTaskMeta` 新增 `timeoutMs`：任务声明 `task.timeoutMs` 后在独立 worker 线程执行，超时两段式取消——先 abort 信号给任务优雅退出（宽限 5s），未退出 `terminate()` 硬杀。Node 主线程无法强杀协程，进程内"不再等待"式超时是假取消（控制侧记失败、重试已投递，旧协程仍在跑）；隔离执行保证判定超时即执行真正终止
- 隔离任务边界：worker 冷启动开销、模块级状态每次执行独立、`taskCtx.config` 为可克隆纯数据快照、返回值须可结构化克隆
- 驱动子包（@faapi/task-pgboss / @faapi/task-bullmq）：`stop` 超时后 abort 在跑任务的 signal——停机时任务可感知退出（此前信号永不触发），进程退出兜底终止

未声明 `timeoutMs` 的任务行为不变（进程内执行，零开销）。
