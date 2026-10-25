# isolatedWorkerBudget

一句话概括：跨任务的全局隔离 worker 并发预算——每进程同时运行的 worker 线程数不超过上限，超出的派发在有界等待后显式失败交驱动重试。

## 为什么需要

每个隔离任务派发都新建一个 worker 线程（独立 V8 isolate）。单个任务有 `concurrency`（默认 1）与 `timeoutMs` 两道堤，但 N 个任务的并发会累加：多个 CPU 密集任务的并发总和超过机器核数时，宿主进程在 OS 层被挤压（worker 不阻塞宿主事件循环，但抢物理核）。

全局预算把「同时运行的 worker 数」收敛为显式上限，默认 `max(1, os.availableParallelism() - 1)`——为宿主事件循环保留一个核心；可通过 `config.task.maxIsolatedWorkers` 调整。

## 为什么等待必须有上限（30s）

有界等待是驱动语义约束，不是风格选择：pgboss 驱动按 `expire_in = timeoutMs + graceMs + 60s 缓冲` 设执行硬限，预算内未 complete 会被判失联**重投**（同任务重复执行，靠结算 SQL 守卫兜底）。派发等待发生在 job 已被驱动投出之后（expire_in 已起算），若无限排队：

- 等待超过 expire_in → 驱动侧判失败重投，原执行仍在等席位 → 重复派发
- bullmq 驱动锁自动续期无此问题，但跨驱动统一口径仍取有界等待

等待上限 `ISOLATED_DISPATCH_WAIT_MS = 30_000`（30s）< 60s 缓冲：等待只消耗 expire 预算的缓冲余量，执行预算（`timeoutMs + graceMs`）完整保留。等待超限抛 `IsolatedDispatchSaturatedError`——该次派发显式失败、交驱动按 `retries` 重试，属于 fail-fast 而非静默降级。

## 使用场景

- `taskQueue` 的隔离派发分支：调用 `runIsolated` 前 `acquire(job.signal)`，执行落定（成功/失败/取消）后 `release()`
- 进程内任务（task.ts）不创建 worker，不经过预算
- 多实例部署时每进程独立一份预算（进程内计数）

## 相关模块

- `taskQueue.ts` - 唯一消费方：隔离分支 acquire/release，配置解析（`config.task.maxIsolatedWorkers`）
- `taskWorker.ts` - `TaskCancelledError`（等待中 signal abort 时抛出，与执行取消同语义）；执行器本身无预算感知
- `configTypes.ts` - `TaskConfig.maxIsolatedWorkers` 配置字段
