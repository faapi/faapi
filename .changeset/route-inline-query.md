---
'@faapi/faapi': patch
---

HTTP 路由 input 形参支持内联类型字面量标注（`query: { page: number }` 写法），与具名引用（`query: Query`）同为「声明即校验」——此前内联标注构建期被静默跳过（无 schema 即无校验）：

- `analyzeInjection` 对 TypeLiteral 标注置 `ParamMeta.inline = true`；同时删除无生产消费方的 `ParamMeta.schema` / `PropertyInfo` 死代码
- schema 收集经新增 `extractInlineParamTypeInfo` 从标注节点直接解析，与具名路径同一套 `resolveTypeNode` 类型管线；schema 名仍为合成名 `<METHOD>Query` / `<METHOD>Params` / `<METHOD>Body`（schema 导出名本就不依赖标注具名），coerce 语义与具名形态完全一致（后缀正则推断 + form 显式覆盖）
- 约束：仅支持纯 TypeLiteral（交叉/联合/关键词标注维持静默无校验）；合成 schema 名与文件内已有顶层类型声明同名时构建期抛 `SchemaExtractionError`（校验源歧义 + zod.js 双重声明，fail-fast，与 tool ctx 的 `synthesizeCtxName` 同款）；WS 路由不适用（Query/Params 是文件级约定声明）
