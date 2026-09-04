---
'@faapi/faapi': patch
---

AST 提取链路惰性化重构（健壮性 + 性能）

- **无关类型不再拖垮 build**：schema 提取改为惰性解析——只解析路由入口类型及其引用可达的类型，文件中未被任何入口引用的类型（哪怕含不支持语法）不再触发 `SchemaExtractionError` 拖垮整个 build/reload。此前 `extractAllTypes` 提前解析文件全部顶层类型，一个无关的坏类型就会让提取整体失败
- **消除重复解析**：`analyzeInjection` 新增 `analyzeInjectionInSourceFile` 变体，复用 program 已解析的 SourceFile——此前同一文件 N 个方法会重复 `createSourceFile` 全量 parse N 次；入口类型经 `createLazyTypeResolver` 缓存解析，消除 `extractAllTypes` + `extractTypeInfo` 对同一类型的重复提取
- **API 调整**：`collectRouteSchemaSources` 返回值中 `allTypesByFile` / `mergedAllTypes` 替换为 `resolversByFile`（按文件的惰性类型解析器，`resolve(name)` 缓存幂等）；`generateSchemaFileSource` / `generateToolSchemaFileSource` 的 `allTypes` Map 参数改为 `resolveType` 函数。`extractAllTypes` 保留为独立 AST 能力不变
- tool schema 收集（`collectToolSchemaSources`）同步惰性化，收益与路由 schema 一致
