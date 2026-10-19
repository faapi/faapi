---
'@faapi/faapi': minor
---

隔离任务上下文能力对齐：`IsolatedTaskContext` 新增 config / suspend / resumed

- **`taskCtx.config`（必有）**：进程配置的派发时刻**纯数据快照**——新模块 `collectConfigSnapshot` 投影：函数值（lifecycle 钩子 / `task.onFailed` / log sink / middlewares 等宿主行为面）与 symbol 值不进快照（与 registries 快照同款能力边界），其余值 `structuredClone` 保真（Date/Map/Set 原样）；含非函数不可克隆值（Promise/WeakMap 等）时任务**派发显式报错并列出路径**（fail fast，不剔除不降级）。读数据字段（端口/驱动选项/llms/业务自定义段）不再需要 payload 手工搬运
- **`taskCtx.suspend(state?)`（可选）**：与进程内 `TaskContext.suspend` **语义零差**——经 `{ type: 'suspend' }` 消息 RPC 回传宿主执行同一信封写入（两路径共用 `persistSuspendEnvelope`），任务记录转 suspended、run 正常返回、`tasks.resume` 激活；state 须可结构化克隆（不可克隆按执行错误处理），驱动无 `taskState` 错误原样回传 worker
- **`taskCtx.resumed`（可选）**：激活重投时随 run 消息透传 `{ state, inject?, activations }`（信封为纯数据），首跑 `undefined`——两路径读取方式一致
- 剩余差异不变（隔离固有代价）：registries/llm 快照重建、模块级状态独立、克隆约束、两段式真终止、冷启动开销。文档见 `configSnapshot.md` / `taskSuspend.md` / `taskTypes.md` 差异表
