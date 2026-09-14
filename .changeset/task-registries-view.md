---
'@faapi/faapi': minor
---

任务侧注册表只读视图（`TaskContext.registries`）：任务执行侧（进程内 + 隔离 worker 两条路径）均可经 `taskCtx.registries` 访问 app 已水合的 agent/tool/skill 元数据（只读查询视图，不含 `hydrate`/`clear` 写接口），在任务内组装/调用 agent 不再依赖 `getApp()`——注册表为 app 实例级，全局访问器读的是 app 启动从不水合的默认实例，`getApp()` 在隔离 worker 内也不可用（globalThis 独立），任务侧此前没有任何注册表访问路径。进程内为活引用；隔离任务（声明 `timeoutMs`）为派发时刻的纯数据快照（agents 含 filePath/hasRun 完整元数据 + tools + skills），postMessage 传入 worker 内重建视图——快照语义，执行中途 reload 不影响当次执行。新增导出：`TaskRegistriesView` / `TaskRegistriesSnapshot` 类型与 `createTaskRegistriesView` 工厂。注意：`TaskContext` 新增必填 `registries` 字段，手工构造 `TaskContext` 的代码（极少见，通常仅测试）需补传该字段。
