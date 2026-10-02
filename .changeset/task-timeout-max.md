---
'@faapi/faapi': minor
---

任务 `timeoutMs` 新增构建期上限校验（23h），与最小 60s 对称：

- `src/tasks/<name>/task.ts` 声明 `timeoutMs` 超过 23h（82,800,000ms）时 dev/build 启动期直接报错（`scanTasks` 校验，越界不钳制）——pg-boss 驱动按 timeoutMs 给 expire_in 执行预算（防止任务执行中途被 pg-boss 判失联重投导致双重执行），而 pg-boss 10 断言 expire_in 严格小于 24h，此前声明 ≈24h 的任务会在入队时抛晦涩的 AssertionError；23h 为预算留约 1h 余量
- 需要更长执行预算的任务拆为可恢复的分段流水线（自行落进度、多次入队续跑），或改用 `@faapi/task-bullmq` 驱动（Redis 无此上限）
