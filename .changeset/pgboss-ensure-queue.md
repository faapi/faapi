---
'@faapi/task-pgboss': patch
'@faapi/faapi': patch
---

修复 enqueue 对未创建队列抛 "pg-boss send failed"：pg-boss v10 不再隐式建队列（send 对未创建队列静默返回 null，work 也不建队列）。驱动现在在投递（enqueue）与注册 worker（startWorker）前自动幂等 createQueue（create_queue plpgsql ON CONFLICT DO NOTHING，已存在直接返回），每任务名每进程一次、进程内缓存短路、并发投递去重；空库冷启动首次 enqueue 不再 500。业务方此前在 onReady 中按任务清单手工 createQueue 的变通逻辑可移除。

另修复启动时序：`createAppBase` 现在 await 任务队列启动——listen 前 worker 注册/队列创建已就绪（此前 `taskQueue.start()` 是浮动 promise，冷启动首次 enqueue 可能早于 worker 注册投递，驱动启动失败还会变成 unhandled rejection）；驱动启动失败（队列库不可达等）时 createAppBase 直接 reject，端口不暴露（fail fast）。驱动侧 `ensureBoss` 并发首调共享同一次 `boss.start()`（半启动实例不外借），start 失败坏实例不入缓存可重试。
