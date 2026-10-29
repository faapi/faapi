---
'@faapi/faapi': minor
'@faapi/agent': minor
'@faapi/task-pgboss': minor
---

移除隔离 worker 任务功能，任务系统收敛为进程内单路径（全部任务 `src/tasks/<name>/task.ts` 声明，进程内执行）。

- 删除 `src/tasks/<name>/worker.ts` 声明方式与 `FaapiWorkerTaskMeta` / `IsolatedTaskContext` / `IsolatedTaskModule` / `TaskRegistriesSnapshot` / `AgentSnapshotRecord` 公开类型；历史 worker.ts 声明被扫描静默忽略（维护者决策）
- 删除 `config.task.maxIsolatedWorkers` 配置与 `IsolatedWorkerBudget` 并发预算；删除超时两段式取消（真终止）——停机取消由驱动 signal abort 承担（`job.signal.aborted` 判定记 `cancelled`），`TaskCancelledError` 迁至主包公开导出（`taskTypes.ts`）
- 删除隔离 RPC 通道（tasks / llm-complete / agent-run / suspend 四个 postMessage 代理）与 `@faapi/agent` 的 `AgentRpcHandle` / agentRunner 注册；`taskCtx.agent` / `taskCtx.llm` / `taskCtx.tasks` / `taskCtx.emit` 进程内语义不变
- `faapi-tasks.js` 清单不再含 `mode` 字段（仅 name/filePath/cron/concurrency/retries），产物不再生成 worker.js——**存量部署升级后需重新 `faapi build`**
- `@faapi/task-pgboss`：`TaskDriver.enqueue` opts 的 `timeoutMs`/`graceMs` 删除——全部任务统一走 `defaultExpireSeconds` 兜底（默认 24h−1s，可按部署调整），消除 15 分钟强杀风险（每次 send 仍显式设 expire_in）
- 停机 abort 后进程内任务协程会跑到自然结束（无真终止）——需要硬杀的长任务由部署层承接，如实声明
