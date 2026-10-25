---
'@faapi/faapi': minor
---

任务子系统新增两项资源护栏（CPU/内存密集隔离任务的部署安全网）：

- **跨任务全局 worker 并发预算**：新增 `config.task.maxIsolatedWorkers`（默认 `max(1, os.availableParallelism() - 1)`，预留 1 核给宿主事件循环）——跨任务封顶同时在跑的隔离 worker 线程数。单任务并发（meta.concurrency，默认 1）只约束同名任务，多个隔离任务并发时线程数累加抢核由此封顶。超限的派发最多等待 30s（低于 pgboss expire_in 的 60s 缓冲，不侵蚀执行预算也不产生失联重投的活锁窗口），仍无席位则显式失败（`IsolatedDispatchSaturatedError` → 任务 failed）交驱动按 retries 重试；排队等待不计入 `timeoutMs`，等待中任务被取消记 `cancelled`。配置非法（<1 或非整数）启动即报错。
- **worker 堆上限**：隔离任务 meta 新增可选 `maxOldGenerationSizeMb`（数字字面量，MB，下限 16）——透传 Node `worker_threads` 的 `resourceLimits.maxOldGenerationSizeMb`，worker 堆超限即被 V8 终止（`ERR_WORKER_OUT_OF_MEMORY`），任务记 `failed` 交驱动按 retries 重试，内存失控显式失败而非拖慢整机。未声明不传 resourceLimits（Node 默认堆上限，行为不变）；低于下限 16 在构建期扫描即报错。

详见 `packages/faapi/src/tasks/isolatedWorkerBudget.md`、`taskWorker.md`、`scanTasks.md`。
