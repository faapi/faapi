# taskQueue

一句话概括：进程内内存任务队列——enqueue 入队（payload zod 校验）→ 按任务并发数派发执行 → 失败按重试次数指数退避重试 → 超限记为 failed；stop 优雅停机等待在跑任务。

## 为什么需要

异步任务的核心执行引擎：把"投递即执行"解耦为队列缓冲 + worker 调度，让 handler 请求路径不被耗时工作阻塞，并提供可靠性语义（重试、失败记录、优雅停机）。

## 使用场景

- handler / 中间件 / lifecycle 钩子 / cron 通过 TaskClient（队列的门面）入队
- `createAppBase` 创建并启动（不依赖 HTTP listen）；`app.close()` 时 drain

## 行为约定

- `enqueue(name, payload?, opts?)`：
  - 任务不存在抛错（含可用任务名提示）
  - 有 Payload schema（任务目录 `zod.js` 导出 `${PayloadTypeName}Schema`）时 safeParse，不合法抛 `ValidationError`（HTTP 语义 422）；无 schema 跳过校验（与 tool 对齐）
  - 返回 `{ id }`（uuid）
- 执行：每个任务最多 `concurrency`（默认 1）个同时运行；worker 从队首取任务，import 任务模块（缓存），调用 `run(payload, { signal, job, config })`
- 重试：`run` 抛错且 `attempts <= retries`（默认 0）时，延迟 `min(500 * 2^(attempt-1), 30_000)` ms 重新入队；超限置 `failed`（保留 error）
- 任务记录：`pending / running / retry / done / failed`，`list(name?)` 返回快照；内存驱动不做持久化（重启即丢，见 fallback.md）
- `stop(timeoutMs)`：停止出队 + 停 cron，等待在跑任务结束，超时对未完成任务 abort（`signal`）后返回
- 模块加载失败：`failed`（error 为原始异常），不静默吞掉

## 相关模块

- `src/task/taskRegistry.ts` — 派发时查任务 meta
- `src/cli/generateTaskArtifacts.ts` — zod.js 路径规则（与任务模块同目录）
- `src/validator/` — ValidationError
- `src/task/cronScheduler.ts` — cron 到点调 enqueue
