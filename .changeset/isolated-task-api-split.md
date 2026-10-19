---
'@faapi/faapi': minor
---

任务声明 API 拆分：隔离任务与进程内任务显式分离

- **两种声明 API（文件名即执行语义）**：`src/tasks/<name>/task.ts` = 进程内任务（`FaapiTaskMeta` 收窄为 `{ concurrency? / retries? / cron? }`），`src/tasks/<name>/worker.ts` = 隔离任务（新类型 `FaapiWorkerTaskMeta`，`timeoutMs` 必填 60s~23h，`graceMs?` 等）。执行路径由声明文件种类决定，不再由 `timeoutMs` 有无隐式判定
- **构建期迁移报错**：`task.ts` 声明 `timeoutMs` / `graceMs` → 报错并指引改名 `worker.ts`；`worker.ts` 缺 `timeoutMs` → 必填报错；同目录 `task.ts` 与 `worker.ts` 并存 → 冲突报错
- **清单与类型**：`TaskManifest` / `TaskMetadata` / 序列化记录新增必填 `mode: 'inline' | 'isolated'`；`TaskModule.run` 第二参收窄为 `TaskContext`，隔离任务模块类型 `IsolatedTaskModule`（`IsolatedTaskContext`）
- **ctx 标注构建期校验**：run 第二参类型标注与文件种类不符（worker.ts 标 `TaskContext` / task.ts 标 `IsolatedTaskContext`）构建期报错——路径错注从运行时静默变构建期失败
- **运行时**：`runJob` 隔离判据改为 `meta.mode`，隔离任务缺 `timeoutMs` 的损坏清单派发即显式抛错（不静默走进程内）
- **迁移指引**：原「task.ts 声明 timeoutMs 即隔离」的写法改为改名 `worker.ts`；原用 timeoutMs 做上限保护的快速任务直接删掉该字段（进程内 deadline 自行 `Promise.race`）
