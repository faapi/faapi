# taskQueue

一句话概括：任务队列语义层——enqueue 入队（payload zod 校验）交由驱动存储，worker 执行由驱动派发回调本层包装（模块加载 + run 调用 + 任务记录），stop 优雅停机透传驱动 drain。

## 为什么需要

异步任务的核心执行引擎：把"投递即执行"解耦为队列缓冲 + worker 调度，让 handler 请求路径不被耗时工作阻塞，并提供任务记录等可观测语义。存储/消费/重试/停机由驱动（TaskDriver）承载，本层对任何驱动保持一致的校验与记录语义。

## 使用场景

- handler / 中间件 / lifecycle 钩子 / cron 通过 TaskClient（队列的门面）入队
- `createAppBase` 创建并启动（不依赖 HTTP listen）；`app.close()` 时 drain

## 行为约定

- `enqueue(name, payload?, opts?)`：
  - 任务不存在抛错（含可用任务名提示），不触达驱动
  - 有 Payload schema（任务目录 `zod.js` 导出 `${PayloadTypeName}Schema`）时 safeParse，不合法抛 `ValidationError`（HTTP 语义 422）；无 schema 跳过校验（与 tool 对齐）
  - 校验后的 payload + `retries`（任务 meta）+ `delayMs` 透传给 `driver.enqueue`，返回驱动侧 `{ id }`
- worker 执行（驱动按并发/重试策略调 `process`）：import 任务模块（缓存），调用 `run(payload, { signal, job, config })`；每次 process 更新记录 `running`（attempts 递增），返回写 `done`（保留 result），抛错写 `failed`（保留 error）后向上传播——是否重试由驱动决定
- 任务记录：`pending / running / retry / done / failed`，`list(name?)` 返回快照；持久化与历史记录由驱动负责，本层记录为当前进程内存活快照
- `stop(timeoutMs)`：停止接受新任务，透传 `timeoutMs` 给 `driver.stop`（drain/abort 语义由驱动实现）；停止后 `enqueue`/`start` 抛错
- `reload()`：调 `driver.stopWorkers?` 后按最新注册表重新注册 worker（dev reloadTasks 热替换路径）
- 模块加载失败：`failed`（error 为原始异常），不静默吞掉

## 相关模块

- `src/task/driverTypes.ts` — 驱动边界（并发/重试/停机语义在驱动侧）
- `src/task/taskRegistry.ts` — 派发时查任务 meta
- `src/cli/generateTaskArtifacts.ts` — zod.js 路径规则（与任务模块同目录）
- `src/validator/` — ValidationError
- `src/task/cronScheduler.ts` — cron 到点调 enqueue
