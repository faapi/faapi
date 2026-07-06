# collectRouteSchemaSources

一句话概括：从路由清单按文件分组，用 AST（`createProgram` + `extractAllTypes` + `analyzeInjection`）提取每个路由的 schema 类型源数据，dev/prd 共用。

## 为什么需要

`generateSchemaFiles` 需要每个路由的 input 类型信息（Query/Params/Body）来生成 `zod.js`。本函数负责从路由清单收集这些类型源数据：

- 按文件分组遍历路由（同一文件的多个方法共享一次 AST 解析）
- 对每个文件 `createProgram` + `extractAllTypes` 收集所有类型
- 用 `analyzeInjection` 分析 handler 函数签名，找 input 类型对应的参数
- 用 `extractTypeInfo` 提取参数的 interface 类型信息

schema key 使用 `urlPath`（如 `/api/hello`）而非 `filePath`，因为 `urlPath` 在 dev/prod 完全一致，无需路径桥接。

## 使用场景

- `generateSchemaFiles` 调用本函数收集 sources，再基于 sources 生成各 `zod.js`
- dev 模式：`devCommand` 启动时 + watch 时调 `generateSchemaFiles`（内部调本函数）
- prd 模式：`faapi build` 调 `generateSchemaFiles`（内部调本函数）

## API

```ts
function collectRouteSchemaSources(
  routes: RouteManifest,
  rootDir?: string,
): {
  sources: RouteSchemaSource[];
  allTypesByFile: Map<string, Map<string, HandlerTypeInfo>>;
  mergedAllTypes: Map<string, HandlerTypeInfo>;
}
```

| 返回字段 | 用途 |
|----------|------|
| `sources` | 每个路由的 schema 提取结果（`urlPath`/`filePath`/`schemaName`/`typeInfo`） |
| `allTypesByFile` | 按文件分组的类型映射（prd `writeSchemaModule` 用） |
| `mergedAllTypes` | 合并后的全局类型映射（兼容旧调用方） |

`rootDir` 传入则 `path.resolve(rootDir, route.filePath)` 解析为绝对路径，否则用 `route.filePath` 原值。

## 关键行为

- `sourceFile?.text ?? ''`：sourceFile 缺失时回退空串
- `param?.typeName ? extractTypeInfo(...) : null`：handler 无 input 类型参数时 `typeInfo` 为 null（不抛错）
- 无 try/catch——AST 异常（如 `SchemaExtractionError`）向上传播，依赖调用方处理

## 相关模块

- `generateSchemaFiles.ts` - 调用本函数收集 sources，生成 `zod.js` + `faapi-helpers.js`
- `createProgram.ts`（ast）- 创建 TypeScript Program
- `extractHandlerTypes.ts`（ast）- `extractAllTypes` + `extractTypeInfo`
- `analyzeInjection.ts`（injection）- 分析 handler 函数签名，找 input 类型参数
- `inputType.ts`（runtime）- `getInputTypeForMethod` 判断方法对应的 input 类型（Query/Body）
- `schemaName.ts`（validator）- `getSchemaName` 生成 schema 命名（如 `GETQuery`/`POSTBody`）
