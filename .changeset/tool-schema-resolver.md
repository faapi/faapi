---
'@faapi/agent': minor
---

新增公开导出 `createToolSchemaResolver({ rootDir? })`——任务内组装 Agent 时 `AgentDeps.resolveToolSchema` 的官方工厂。

此前该装配逻辑（`loadToolSchema` + `z.toJSONSchema` + `safeParse`）是 `@faapi/agent` 插件内部实现，任务侧手动组装 Agent 只能拿到返回 `{ schema, schemaName }` 原始 zod 模块的 `loadToolSchema`，直连后运行时报 `schemaRes.validate is not a function`。现将插件内部实现抽为公开工厂（带 mtime 缓存，与插件行为一致），`rootDir` 缺省 `process.cwd()`（任务侧 `TaskContext` 无 rootDir）；插件 setup 同步改为复用该工厂。另在任务侧文档（taskTypes.md「任务内组装 Agent」章节）补充完整 deps 组装示例。
