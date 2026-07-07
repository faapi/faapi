# TypeScript AST 分析

TypeScript AST 分析，提取 handler 的 interface 类型信息，生成 zod schema 代码，实现"类型即校验"。

## 模块

| 模块 | 说明 |
| --- | --- |
| [createProgram.ts](./createProgram.ts) | 创建 TypeScript Program，配置编译选项 |
| [extractHandlerTypes.ts](./extractHandlerTypes.ts) | 提取 interface 类型信息：属性名、类型、是否可选 |
| [resolveTypeNode.ts](./resolveTypeNode.ts) | 解析类型节点为 RuntimeType，不支持时抛 SchemaExtractionError |
| [generateZodSchema.ts](./generateZodSchema.ts) | 将 RuntimeType 转换为 zod schema 代码字符串 |

## 分析流程

```
filePath
  → createProgram（创建 TS Program）
  → getSourceFile（获取源文件 AST）
  → 遍历顶层节点，匹配 InterfaceDeclaration
  → 提取属性：name + resolveTypeNode(type) + optional
  → HandlerTypeInfo { name, properties[], runtimeType }
  → generateZodSchema(runtimeType) → zod schema 源码
```

## 支持的类型

| TypeScript 类型 | 运行时类型 |
| --- | --- |
| `string` / `number` / `boolean` | 对应基础类型 |
| `null` / `undefined` / `unknown` | 对应类型（unknown 不校验） |
| 字面量 `'foo'` / `42` / `true` | `literal` |
| `T[]` / `Array<T>` | `array` |
| `[string, number]` / `[string, number?]` / `[string, ...number[]]` | `tuple`（按位置校验） |
| `{ name: string }` | `object` |
| `A \| B` | `union` |
| `A & B` | `object`（合并属性） |
| `Date` | `date`（允许 Date 实例或 ISO 8601 字符串） |
| `Record<K, V>` | `record` |
| `Partial<T>` / `Required<T>` / `Readonly<T>` | 解析内部类型 |
| `Pick<T, K>` / `Omit<T, K>` | 解析 T 的字段，按 K 筛选/排除（K 支持字面量联合、类型别名、`keyof T`） |
| `Map<K, V>` | `map`（JSON 序列化为 entries 数组，运行时 `z.preprocess(coerceMap, z.map(...))` 还原） |
| `Set<T>` | `set`（JSON 序列化为数组，运行时 `z.preprocess(coerceSet, z.set(...))` 还原） |
| `enum Role { Admin = 'admin' }` | `union`（字面量联合） |
| 自引用 / 循环引用 | `ref`（由 `generateZodSchema` 用 `z.lazy` 处理） |

## 不支持的类型（抛错）

以下类型在解析时抛 `SchemaExtractionError`，避免静默降级为 any：

| 类型 | 原因 |
| --- | --- |
| `any` / `void` / `never` / `object` | 显式声明应使用 `unknown` 表示不校验 |
| `bigint` | HTTP/JSON 不能传输,请改用 `string` 或 `number` |
| `symbol` | HTTP/JSON 不能传输 |
| `Function` | HTTP/JSON 不能传输 |
| 裸 `Map` / `Set`（无类型参数） | 必须写 `Map<K,V>` / `Set<T>` 形式 |
| `WeakMap` / `WeakSet` | 运行时无法枚举校验 |
| `Promise<T>` | 运行时无法校验异步值 |
| Pick/Omit 的 T 非 object | 无法筛选字段 |
| Pick/Omit 的 K 无法解析 | 无法确定字段集合 |
| checker 无法解析的引用 | 类型声明有误或不支持 |
| 无法识别的语法节点 | AST 不支持 |

错误信息包含类型文本和原因，上层补充文件路径后抛出，方便用户在开发时定位并改正。

## zod schema 生成

`generateZodSchema` 将 RuntimeType 转换为 zod schema 代码字符串：

- 每个命名类型生成一个 `NameSchema` 声明（循环引用用 `z.lazy(() => schema)` 包裹）
- 循环引用通过 `z.lazy` 延迟求值，天然支持递归
- `generateSchemaFiles` 为每个 handler 生成 `zod.js`（与 handler.js 同级），dev 模式写入 `.faapi/dev/`，prd 模式写入 `.faapi/build/`

## 相关模块

- [validator](../validator/README.md)：import 生成的 zod.js 进行输入校验
- [cli/generateSchemaFiles](../cli/generateSchemaFiles.md)：调用本模块为每个 handler 生成 zod.js
- [@faapi/schema](../../../schema/)：调用 AST 分析生成路由 schema（通过 MCP 暴露给 LLM）
