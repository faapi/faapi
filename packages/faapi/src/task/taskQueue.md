# taskQueue

一句话概括：任务队列语义层——enqueue 入队（payload zod 校验）交由驱动存储，worker 执行由驱动派发回调本层包装（模块加载 + run 调用 + 任务记录，声明超时的任务走隔离线程真终止），stop 优雅停机透传驱动 drain。

## 为什么需要

异步任务的核心执行引擎：把"投递即执行"解耦为队列缓冲 + worker 调度，让 handler 请求路径不被耗时工作阻塞，并提供任务记录等可观测语义。存储/消费/重试/停机由驱动（TaskDriver）承载，本层对任何驱动保持一致的校验与记录语义。

## 使用场景

- handler / 中间件 / lifecycle 钩子 / cron 通过 TaskClient（队列的门面）入队
- `createAppBase` 创建并 await 启动完成后才继续后续启动步骤（listen 时 worker 注册/队列创建已就绪，冷启动首次 enqueue 不会早于 worker 注册；驱动启动失败 → createAppBase reject，端口不暴露）；`app.close()` 时 drain

## 行为约定

- `enqueue(name, payload?, opts?)`：
  - 任务不存在抛错（含可用任务名提示），不触达驱动
  - 有 Payload schema（任务目录 `zod.js` 导出 `${PayloadTypeName}Schema`）时 safeParse，不合法抛 `ValidationError`（HTTP 语义 422）；无 schema 跳过校验（与 tool 对齐）
  - 校验后的 payload + `retries`（任务 meta）+ `delayMs`/`dedupId` 透传给 `driver.enqueue`，返回驱动侧 `{ id }`；`dedupId` 为幂等键（同键不重复入队，重复投递返回已存在任务 id），cron 投递自动携带
- `onFailed` 钩子（`config.task.onFailed`）：每次 process 抛错后触发（含将重试的失败），`info = { task, jobId, attempt, willRetry, cancelled, error }`——`willRetry` 按任务 meta.retries 推算（attempt <= retries）；用于告警/死信上报等副作用，自身抛错被忽略
- worker 执行（驱动按并发/重试策略调 `process`），按任务 meta 分两条路径：
  - **进程内**（默认）：import 任务模块（缓存），调用 `run(payload, { signal, job, config })`
  - **隔离执行**（任务声明 `timeoutMs`）：走 taskWorker 独立线程执行，超时两段式取消（abort 信号宽限 → terminate 硬杀）——判定超时即执行真正终止，详见 taskWorker.md
  - 每次执行更新记录 `running`（attempts 递增），返回写 `done`（保留 result），抛错写 `failed`（保留 error）后向上传播——是否重试由驱动决定
- 任务记录：`pending / running / retry / done / failed / cancelled`，`list(name?)` 返回快照；**取消与失败分流**——执行被框架终止（隔离执行超时终止、停机取消）记 `cancelled`（`TaskCancelledError` 或 job.signal 已 abort），run 自身抛错记 `failed`，两者都向上抛错交驱动按 retries 重试，重试派发后记录回 `running` 继续流转；持久化与历史记录由驱动负责，本层记录为当前进程内存活快照（stop 后未消费的 pending 任务不标记——持久化驱动下重启后继续执行）
- `listQueued(name?)`：持久化队列视图——驱动实现 `TaskDriver.list` 时返回队列侧任务（含其他实例/历史执行），并与本进程记录按 id 合并（本进程观测优先：status/attempts/result/error 以本进程为准）；驱动未实现时显式抛错（能力边界见 driverTypes.md：pgboss 未实现 list，BullMQ 全支持）
- `cancel(name, id)` / `retry(name, id)`：透传驱动可选管理方法；本地有该 id 记录时同步更新（cancel → `cancelled`，retry → `pending` 等待重新派发）；驱动未实现时显式抛错
- `stop(timeoutMs)`：停止接受新任务，透传 `timeoutMs` 给 `driver.stop`（drain/abort 语义由驱动实现；驱动超时后 abort 在跑任务的 signal，进程内任务监听退出，进程退出兜底终止）；停止后 `enqueue`/`start` 抛错
- `reload()`：调 `driver.stopWorkers?` 后按最新注册表重新注册 worker（dev reloadTasks 热替换路径）
- 模块加载失败：`failed`（error 为原始异常），不静默吞掉

## 相关模块

- `src/task/taskWorker.ts` — 隔离执行器（timeoutMs 任务）
- `src/task/driverTypes.ts` — 驱动边界（并发/重试/停机语义在驱动侧）
- `src/task/taskRegistry.ts` — 派发时查任务 meta
- `src/cli/generateTaskArtifacts.ts` — zod.js 路径规则（与任务模块同目录）
- `src/validator/` — ValidationError
- `src/task/cronScheduler.ts` — cron 到点调 enqueue
