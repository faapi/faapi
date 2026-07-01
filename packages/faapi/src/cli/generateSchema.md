# generateSchema

一句话概括：从路由清单提取所有 handler 的 schema，生成校验函数（dev 预生成 `.faapi/dev/faapi-schema.js` / build 写入 `dist/faapi-schema.js`，均 import 加载）。

## 为什么需要

`schemaRegistry` 需要 schema 数据才能工作。schema 数据的来源是 TypeScript AST 分析，但提取时机因模式而异：

- **dev 启动**：全量扫描路由 → 提取 schema → 写入 `.faapi/dev/faapi-schema.js` → `registry.loadManifest`
- **dev watch**：文件变化 → 重新生成 `.faapi/dev/faapi-schema.js` → `registry.loadManifest`（全量重建，非增量）
- **build**：全量扫描路由 → 提取 schema → 写入 `dist/faapi-schema.js`
- **prd 启动**：读取 `dist/faapi-schema.js` → `registry.loadManifest`

`generateSchema` 封装"从路由清单提取 schema"这一核心逻辑，供 dev 启动、dev watch、build 三处复用。

## 使用场景

- `faapi build`：全量提取 → 写入 `dist/faapi-schema.js`
- `faapi`/`faapi dev` 启动：全量提取 → 写入 `.faapi/dev/faapi-schema.js` → `schemaRegistry.loadManifest`
- watch 文件变化：重新生成 `.faapi/dev/faapi-schema.js` → `schemaRegistry.loadManifest`
- `faapi start`（prd）：读取 `dist/faapi-schema.js` → `schemaRegistry.loadManifest`

## API

| 方法 | 说明 |
|------|------|
| `generateSchemaFile(routes, rootDir, outputPath)` | 从路由清单提取 schema 并生成 JS 模块文件（dev/build 共用） |
| `writeSchemaModule(entries, allTypesMap, outputPath)` | 生成 JS 模块源码并写入文件 |
| `readManifestFile(inputPath)` | 动态 import JS 模块并转为 SchemaManifest |
| `loadSchemaToRegistry(schemaPath, rootDir, prodDir, remap)` | 加载 schema 文件并注册到 registry（dev/start 共用） |

## 提取流程

`generateSchemaFile` 内部调用 `collectRouteSchemaSources` 收集数据，再调 `writeSchemaModule` 生成 JS 模块文件。

`collectRouteSchemaSources` 两阶段处理：

1. **收集阶段**：遍历所有路由文件，提取每个文件的 `allTypes` 并合并为全局 `allTypesByFile`（用于解析跨文件类型引用）
2. **生成阶段**：每个文件按 method 用 `analyzeInjection` 从 handler 签名提取真实参数类型名，再用该类型名提取 typeInfo

对每个 `(filePath, method)`：

1. `inputType = getInputTypeForMethod(method)`（GET→query, POST→body）
2. `schemaName = getSchemaName(method, inputType)`（如 `GETQuery`）——**仅作存储 key**，运行时查表用
3. `meta = analyzeInjection(code, method)` —— 解析 handler 签名
4. `typeName = meta.params.find(p => p.type === inputType)?.typeName` —— 真实参数类型名（如 `Query`、`CreateUserBody`，可自由命名）
5. `typeInfo = typeName ? extractTypeInfo(program, filePath, typeName) : null`
6. 生成校验函数源码（`generateSchemaModule`），写入 JS 模块文件，运行时 import 加载

### 类型名与存储 key 的分离

- **类型名自由**：用户可写 `interface Query` + `GET(query: Query)`，无需命名为 `GETQuery`
- **存储 key 用约定名**：`schemaRegistry` 的 key 为 `${method}${InputType}`（如 `GETQuery`），保证 dev/prd 运行时查找一致（prd 类型已擦除，只能用 method + inputType 计算 key）
- 提取阶段用 `analyzeInjection` 从 handler 签名拿真实类型名查找类型声明，存储时映射为约定名 key

## 跨文件类型引用

`generateSchemaFile` 与 prd 的 `writeSchemaModule` 行为一致：
先收集所有文件的类型并合并为全局 `allTypes`，再传给每个文件的 schema 生成，
确保跨文件类型引用（包括跨文件循环引用）可解析。

## 相关模块

- [validator/schemaRegistry.ts](../validator/schemaRegistry.ts) - 消费提取结果
- [ast/extractHandlerTypes.ts](../ast/extractHandlerTypes.ts) - 提供 `extractTypeInfo` / `extractAllTypes`
- [ast/generateValidatorCode.ts](../ast/generateValidatorCode.ts) - 生成校验函数源码
- [ast/createProgram.ts](../ast/createProgram.ts) - 创建 TS Program
- [runtime/inputType.ts](../runtime/inputType.ts) - `getInputTypeForMethod`
- [validator/schemaName.ts](../validator/schemaName.ts) - `getSchemaName`（存储 key 生成）
- [injection/analyzeInjection.ts](../injection/analyzeInjection.md) - 从 handler 签名提取真实参数类型名
