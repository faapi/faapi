---
"@faapi/faapi": minor
---

feat(task): 新增队列式异步任务子系统——`src/tasks/<name>/task.ts` 文件约定定义任务（`task` 元信息 + `run(payload, taskCtx)`），进程内内存队列执行，支持并发数、失败重试（指数退避）、cron 定时入队（croner）、payload zod 校验（复用 AST 代码生成链路）、优雅停机 drain。触发入口：`tasks` 参数注入 / `ctx.tasks` / `app.tasks` 与 lifecycle 钩子 `{ tasks }`；产物新增 `faapi-tasks.js` + `tasks/<dir>/zod.js`，dev watcher 支持 `reloadTasks()` 热替换。新增依赖 `croner`。内存队列不持久化、不做多实例防重跑（部署职责，见 fallback.md）。
