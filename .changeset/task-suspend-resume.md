---
'@faapi/faapi': minor
---

新增任务挂起/激活原语：任务执行中 `taskCtx.suspend(state)` 暂存状态并释放执行体（任务记 `suspended` 新状态——非终态也不在跑，不占 worker、不受 expire、计入链式单飞活跃判定），任意入口 `tasks.resume(name, jobId, { inject? })` 激活重投原任务，续跑经 `taskCtx.resumed` 拿到 `{ state, inject?, activations }`。支撑"等外部事件再继续"的长任务编排（人工审批、HTTP 回调等队列外激活源；队列内激活源继续用链式任务 payload 流转）。配套：`cancel` 对挂起任务转 cancelled 并清理信封、`retry` 对挂起任务显式抛错、`queue.start()` 从驱动信封重启水合。依赖驱动新增可选能力 `TaskDriver.taskState`（pgboss 表 / bullmq hash，未实现显式抛错）；挂起仅进程内路径可用（隔离上下文无 suspend 字段）。
