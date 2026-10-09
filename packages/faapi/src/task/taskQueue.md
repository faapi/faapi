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
  - Payload schema（任务目录 `zod.js` 导出 `${PayloadTypeName}Schema`）执行 safeParse，不合法抛 `ValidationError`（HTTP 语义 422）；schema 缺失（zod.js 不存在 / 无 `*Schema` 导出 / 非 safeParse 形态）抛错不静默放行——构建期已强制 Payload 声明必填（generateTaskArtifacts.md），运行时缺产物即产物不一致
  - 校验后的 payload + `retries`（任务 meta）+ `delayMs`/`dedupId` 透传给 `driver.enqueue`，返回驱动侧 `{ id }`；`dedupId` 为幂等键（同键不重复入队，重复投递返回已存在任务 id），cron 投递自动携带
- `onFailed` 钩子（`config.task.onFailed`）：每次 process 抛错后触发（含将重试的失败），`info = { task, jobId, attempt, willRetry, cancelled, error }`——`willRetry` 按任务 meta.retries 推算（attempt <= retries）；用于告警/死信上报等副作用，自身抛错 `console.error` 留痕（不改变已定的失败/重试语义，但不静默）
- worker 执行（驱动按并发/重试策略调 `process`），按任务 meta 分两条路径，**均注入 `taskCtx.registries`（app 注册表只读视图，任务侧组装 agent 用，见 taskTypes.md）**：
  - **进程内**（默认）：import 任务模块（缓存），调用 `run(payload, { signal, job, config, registries })`——registries 为活引用视图（`createAppBase` 创建队列时传入）；config 为活引用全量配置（`FaapiContextConfig`，与 handler `ctx.config` 同一对象）
  - **隔离执行**（任务声明 `timeoutMs`，60s ~ 23h——扫描期校验，理由见 taskWorker.md）：走 taskWorker 独立线程执行，超时两段式取消（abort 信号宽限 → terminate 硬杀）——判定超时即执行真正终止，宽限期默认 5s、经 task meta `graceMs` 按任务配置（详见 taskWorker.md）；registries 以纯数据快照传入（worker 内重建视图，派发时刻快照语义）

- 轻量 LLM 补全通道（`taskCtx.llm`，可选）双路径注入：**进程内**从 `AppRegistries.llm` store 惰性读取（`TaskQueueDeps.llm`，插件晚于队列构造注册，执行时刻取值才可见）；**隔离**传 `agent.llms` 纯数据快照（`TaskQueueDeps.llms`），worker 内重建。详见 taskTypes.md 与 `@faapi/agent` 的 lightComplete.md
  - 每次执行更新记录 `running`（attempts 递增），返回写 `done`（保留 result），抛错写 `failed`（保留 error）后向上传播——是否重试由驱动决定；执行中 `taskCtx.progress(value)` 上报的进度记入记录 `progress` 字段（仅 running 状态生效，两条执行路径语义一致，见 taskTypes.md）；`taskCtx.emit(data)` 发射的过程事件落本层事件缓冲并扇出订阅者（仅 running 状态生效，重试不清事件，随任务记录生命周期淘汰——订阅/查询/保留边界见 [taskEvents.md](./taskEvents.md)）
- **组内成员落定接线**：成员 job 到达最终终态（`done`；`failed`/`cancelled` 且重试额度已尽——`willRetry` 时驱动还会重试，不算落定）时调 `driver.groups.settle` 记账；观察到全部落定的实例自动入队 `onComplete` 回调（dedup 兜底至多一份）；fail-fast 组在成员最终失败时先 `cancelRemaining` 取消未落定成员。记录快照 `TaskJob.groupId` 标记组归属。完整语义见 [taskGroups.md](./taskGroups.md)
- 任务记录：`pending / running / retry / done / failed / cancelled`，`list(name?)` 返回快照；**取消与失败分流**——执行被框架终止（隔离执行超时终止、停机取消）记 `cancelled`（`TaskCancelledError` 或 job.signal 已 abort），run 自身抛错记 `failed`，两者都向上抛错交驱动按 retries 重试，重试派发后记录回 `running` 继续流转；持久化与历史记录由驱动负责，本层记录为当前进程内存活快照（stop 后未消费的 pending 任务不标记——持久化驱动下重启后继续执行）。**终态记录有内存上限**（1000 条，超限按最旧优先淘汰 done/failed/cancelled——pending/running/retry 永不淘汰）：`list()` 为进程内观测快照而非持久化历史，更早的终态记录交由驱动侧视图（`listQueued`，驱动实现 `list` 时）承担
- `listQueued(name?)`：持久化队列视图——驱动实现 `TaskDriver.list` 时返回队列侧任务（含其他实例/历史执行），并与本进程记录按 id 合并（本进程观测优先：status/attempts/result/error 以本进程为准）；两内置驱动均已实现（pgboss 经 pg-boss v12 findJobs 六态精确映射、BullMQ 经 getJobs 状态映射；能力边界见 driverTypes.md）
- `cancel(name, id)` / `retry(name, id)`：透传驱动可选管理方法；本地有该 id 记录时同步更新（cancel → `cancelled`，retry → `pending` 等待重新派发）；驱动未实现时显式抛错。**组内成员同步记账**：cancel 落定 `cancelled`、retry 把已落定成员撤回 pending 时逆向记账（unsettle，幂等守卫防重复计数）
- `enqueueGroup(name, payloads, opts?)` / `getGroup(groupId)`：任务组门面——全量 payload 校验前置（任一失败整组不投递）、组记账 create 幂等、成员 dedupId 自动派生、全部落定自动入队 `onComplete` 回调（dedupId `faapi-group:<groupId>:complete` 兜底至多一份）、fail-fast 取消余下。完整语义见 [taskGroups.md](./taskGroups.md)；驱动未实现组记账（`TaskDriver.groups` 缺失）显式抛错
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
