# collectRouteSchemaSources

一句话概括：从路由清单按文件分组，用 AST（`createPrograms` + 惰性类型解析 + `analyzeInjectionInSourceFile`）提取每个路由的 schema 类型源数据，dev/prd 共用。

## 为什么需要

`generateSchemaFiles` 需要每个路由的 input 类型信息（Query/Params/Body）来生成 `zod.js`。本函数负责从路由清单收集这些类型源数据：

- 按文件分组遍历路由（同一文件的多个方法共享一次 AST 解析）
- 批量 `createPrograms`（全部文件共享同一个 Program）
- 用 `analyzeInjectionInSourceFile` 分析 handler 函数签名（复用 program 已解析的 SourceFile，逐方法零重复 parse），找 input 类型对应的参数
- 用惰性解析器 `createLazyTypeResolver` 解析参数的 interface 类型信息：入口类型立即解析（必须严格校验），ref（同文件循环引用）在生成 zod.js 阶段按需解析并缓存

**惰性语义**：与路由无关的类型（未被任何入口类型引用）不会被解析——文件里存在一个含不支持语法的无关类型不再拖垮整个 build/reload。此前 `extractAllTypes` 提前解析文件全部顶层类型，任何无关类型坏掉都会让提取整体失败。

schema key 使用 `urlPath`（如 `/api/hello`）而非 `filePath`，因为 `urlPath` 在 dev/prod 完全一致，无需路径桥接。

## params 形参的收集

除方法主输入（GET/DELETE/HEAD 的 query、POST/PUT/PATCH 的 body/form）外，handler 声明了 `params: XxxParams` 形参时按方法额外收集一份 `getSchemaName(method, 'params')` 源（如 `GETParams` / `POSTParams`），生成端为命名后缀 `Params` 自动 coerce（路径段来源均为 string）。运行时 createServer 据此校验路径参数并把 coerce 后的值回写 `ctx.params`。

未声明 `params` 形参则不收集——无 schema 即无校验，路径参数保持 URL 原始字符串（与未声明行为一致）。

## 次输入 schema 的收集

方法主输入之外、handler 显式声明的其余输入同样收集（与 params 同理——声明即校验）：

- **body 方法（POST/PUT/PATCH）声明 `query` 形参**：收集 `<METHOD>Query` 源（如 `POSTQuery`），`Query` 后缀自动 coerce（URL query 来源均为 string）。运行时 createServer 校验 query 并把转换值挂载为 `__validatedQuery`，handler 的 query 注入优先取用（此前 body 方法上的 query 声明无 schema，注入恒为原始字符串）。
- **query 主输入方法中 `hasBody` 为 true 的方法（即 DELETE）声明 `body` / `form` 形参**：收集 `<METHOD>Body` 源（如 `DELETEBody`）；声明 `form` 时与主输入 form 同规——schema 名仍为 `<METHOD>Body`、`coerce=true` 显式覆盖。运行时 createServer 校验请求体后注入（Date 字段转换与 POST body 一致；空请求体 undefined 跳过校验）。此前 DELETE body 无校验、Date 字段保持字符串。
- **GET/HEAD 声明 `body`**：不收集（`hasBody` 为 false，运行时 body 注入恒为 undefined，该声明属无效标注，保持既往行为）。

未声明次输入形参则不收集对应 schema：body 方法的 query 注入回退 `queryToObject` 裸字符串、DELETE body 注入原始解析值——与 6.19.x 及之前行为一致。

## 使用场景

- `generateSchemaFiles` 调用本函数收集 sources，再基于 sources 生成各 `zod.js`（ref 解析用 `resolversByFile`）
- dev 模式：`devCommand` 启动时 + watch 时调 `generateSchemaFiles`（内部调本函数）
- prd 模式：`faapi build` 调 `generateSchemaFiles`（内部调本函数）
- dev 按需模式：首次请求 `ensureSchemaGenerated` → `generateSchemaFiles`（同上）

## API

```ts
function collectRouteSchemaSources(
  routes: RouteManifest,
  rootDir?: string,
): {
  sources: RouteSchemaSource[];
  resolversByFile: Map<string, LazyTypeResolver>;
}
```

| 返回字段 | 用途 |
|----------|------|
| `sources` | 每个路由的 schema 提取结果（`urlPath`/`filePath`/`schemaName`/`typeInfo`） |
| `resolversByFile` | 按文件分组的惰性类型解析器（`generateSchemaFileSource` 的 ref 解析用；`resolve(name)` 缓存幂等，未声明返回 null） |

`rootDir` 传入则 `path.resolve(rootDir, route.filePath)` 解析为绝对路径，否则用 `route.filePath` 原值。

## 关键行为

- `sourceFile` 缺失时跳过该文件（不产出 sources）
- `param?.typeName ? resolver.resolve(...) : null`：handler 无 input 类型参数时 `typeInfo` 为 null（不抛错）
- 入口类型解析失败（含不支持语法）抛 `SchemaExtractionError`——入口类型是校验的主体，不降级；与入口无关的类型不解析、不受影响
- POST/PUT/PATCH 方法下，若 handler 声明 `form` 参数（而非 `body`），`collectRouteSchemaSources` 会用 `form` 参数的类型信息填充 `typeInfo`，并在 `RouteSchemaSource` 上设置 `coerce=true`。schema 名仍为 `POSTBody`（与 `body` 共享运行时 schema key），运行时 `validateInput` 无需感知 form/body 差异。

## 相关模块

- `generateSchemaFiles.ts` - 调用本函数收集 sources，生成 `zod.js` + `faapi-helpers.js`
- `createProgram.ts`（ast）- 创建 TypeScript Program
- `extractHandlerTypes.ts`（ast）- `createLazyTypeResolver` + `extractTypeInfo`
- `analyzeInjection.ts`（injection）- `analyzeInjectionInSourceFile` 分析 handler 函数签名
- `inputType.ts`（runtime）- `getInputTypeForMethod` 判断方法对应的 input 类型（Query/Body）
- `schemaName.ts`（validator）- `getSchemaName` 生成 schema 命名（如 `GETQuery`/`POSTBody`）
