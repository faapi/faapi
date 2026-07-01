---
'@faapi/faapi': minor
---

移除 schema 提取的 `new Function` 兜底路径，统一走"生成 JS 模块文件 → import 加载"。

- 删除 `extractSchemasForRoutes` / `typeInfoToSchemaEntry` 导出
- `createServer` 不再在 `schemaRegistry` 为空时自动提取 schema，改由调用方负责加载（dev/start 已由框架内部加载，e2e 测试需显式调用 `generateSchemaFile` + `loadSchemaToRegistry`）
