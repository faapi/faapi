# schemaRegistry

一句话概括：统一管理 handler 的 schema（校验函数 + properties），作为 validateInput 的唯一数据来源，屏蔽 dev/prd 的 schema 获取差异。

## 为什么需要

类型校验需要校验函数（从 AST 提取 RuntimeType 后编译生成）。`validateInput` 每次请求都跑 AST 分析不现实，且 prd 编译后 `interface` 被擦除，AST 分析拿不到类型信息。

`schemaRegistry` 将 schema 的"获取"与"使用"解耦：

- **prd 模式**：`faapi build` 时全量提取 schema 生成校验函数，写入 `dist/faapi-schema.js`，启动时一次性加载到 registry。
- **dev 模式**：启动时全量提取到内存，watch 时全量重新提取并 `loadManifest`（全量重建，非增量）。

`validateInput` 只查 registry，不关心 schema 来源，dev/prd 调用路径完全一致。

## 使用场景

- `validateInput` 校验输入前查询 schema
- `faapi build` 生成 schema JS 模块（调用提取逻辑，不经过 registry）
- `faapi`/`faapi dev` 启动时全量提取并注册到 registry
- watch 模式下文件变化时全量重建 registry
- `faapi start`（prd）启动时从 `faapi-schema.js` 加载到 registry

## 数据模型

```ts
// 单个 schema 条目：包含 properties（用于 coerce）和 validator（用于校验）
// null 表示该 handler 没有对应的类型声明（如 GET() 无参数），校验时跳过
type SchemaEntry = { properties: PropertyType[]; validator: ValidatorFn } | null;

// 单个文件的所有 schema：schemaName -> entry
// schemaName 由 method + inputType 生成，如 'GETQuery'、'POSTBody'
type FileSchemas = Map<string, SchemaEntry>;

// 完整 manifest：filePath -> FileSchemas
type SchemaManifest = Map<string, FileSchemas>;
```

**区分三种状态**：
- `SchemaEntry = { properties, validator }`：有类型声明，执行校验
- `SchemaEntry = null`：handler 无类型声明（如 `GET() { return ... }`），跳过校验
- `registry.get() = undefined`：manifest 不完整（该文件/schema 未注册），抛错

## API

| 方法 | 说明 |
|------|------|
| `loadManifest(manifest)` | 批量加载（覆盖已有数据） |
| `get(filePath, schemaName)` | 查询单条，返回 `SchemaEntry \| undefined` |
| `set(filePath, schemas)` | 设置单个文件的所有 schema |
| `delete(filePath)` | 删除单个文件 |
| `clear()` | 清空（测试用） |
| `hasFile(filePath)` | 判断文件是否已注册 |

## 相关模块

- [ast/generateValidatorCode.ts](../ast/generateValidatorCode.ts) - 生成校验函数源码，提供 `ValidatorFn` 类型
- [ast/resolveTypeNode.ts](../ast/resolveTypeNode.ts) - 提供 `PropertyType` 类型
- [validator/validateInput.ts](./validateInput.ts) - 消费 registry 进行校验
- [cli/generateSchema.ts](../cli/generateSchema.ts) - dev 启动 / build 时全量提取 schema
- [cli/watcher.ts](../cli/watcher.ts) - dev watch 时全量重建 registry
