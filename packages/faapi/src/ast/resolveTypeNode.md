# resolveTypeNode

一句话概括：解析 TypeScript 类型节点为运行时类型，无法解析时抛 `SchemaExtractionError`。

## 为什么需要

将 TypeScript AST 类型节点转换为运行时可用的类型标识（如 'string'、'number'）。
HTTP 视角：JSON 只能传输 string/number/boolean/null/array/object，无法传输的类型
（bigint/symbol/Function）在提取阶段直接报错，避免运行时校验必然失败。

## 使用场景

- AST 遍历时解析类型
- 支持基础类型、对象、数组、元组、联合、交叉、字面量、Record、Partial、Pick/Omit、enum 等

## 支持的类型

| 分类 | 类型 | 备注 |
|------|------|------|
| 基础 | `string` / `number` / `boolean` / `null` / `undefined` | JSON 原生支持 |
| 不校验 | `unknown` | 用户显式声明不校验 |
| 字面量 | `'foo'` / `42` / `true` | |
| 数组 | `T[]` / `Array<T>` / `ReadonlyArray<T>` / `readonly T[]` | readonly 修饰符在运行时无意义,按底层类型解析 |
| 元组 | `[string, number]` / `[string, number?]` / `[string, ...number[]]` / `readonly [T, U]` | 按位置校验,readonly 修饰符忽略 |
| 对象 | `{ name: string }` / `interface` / `readonly` 字段修饰符 | 字段 readonly 修饰符忽略 |
| 联合 | `string \| null` | |
| 交叉 | `A & B` | 按对象合并 |
| 引用 | `Date` / 自定义 interface | Date 允许 Date 实例或 ISO 8601 字符串 |
| 工具 | `Record<K,V>` / `Partial<T>` / `Pick<T,K>` / `Omit<T,K>` | |
| 枚举 | `enum Role { Admin = 'admin' }` | 转为字面量联合 |
| 集合 | `Map<K,V>` / `Set<T>` | JSON 序列化约定见下文"Map/Set 类型"章节 |

完整类型支持清单与 JSDoc 约束标签说明详见 [supported-types.md](./supported-types.md)。

## JSDoc 约束标签

字段级 JSDoc 注释中的约束标签会被提取为 `TypeConstraint[]`,挂在 `PropertyType.constraints` 上,由 `generateZodSchema` 转为 zod 链式方法。

| 标签类别 | 标签 | 适用类型 | zod 方法 |
|---------|------|---------|---------|
| 数值约束 | `@max N` `@min N` `@int` `@positive` `@negative` `@nonnegative` `@nonpositive` | number | `.max(N)` `.min(N)` `.int()` `.positive()` 等 |
| 长度约束 | `@maxLength N` `@minLength N` `@length N` | string / array | `.max(N)` `.min(N)` `.length(N)` |
| 字符串格式 | `@regex /pattern/flags` `@email` `@url` `@uuid` | string | `.regex()` `.email()` 等 |

约束与字段类型不匹配时（如 `@max` 用于 string 字段）直接抛 `SchemaExtractionError`,不降级放行。

## 导出

| 导出 | 说明 |
|------|------|
| `SchemaExtractionError` | 类型提取错误类 |
| `resolveTypeNode(typeNode, checker, visited?)` | 解析类型节点为 RuntimeType |
| `RuntimeType` | 运行时类型描述（discriminated union） |
| `PropertyType` | 字段类型（含 `name` / `type` / `optional` / `constraints?`） |
| `TupleElement` | 元组元素类型 |
| `TypeConstraint` | JSDoc 约束标签的运行时描述（14 种 kind） |

## 错误策略

为避免"静默降级为 any"导致用户不知情，遇到以下情况抛 `SchemaExtractionError`：

- 无法识别的语法节点
- `any` / `void` / `never` / `object`（显式声明应使用 `unknown` 表示不校验）
- `bigint` — HTTP/JSON 不能传输，请改用 `string` 或 `number`
- `symbol` — HTTP/JSON 不能传输
- `Function` — HTTP/JSON 不能传输
- Pick/Omit 的 T 不是 object 类型
- Pick/Omit 的 K 无法解析为字面量集合
- 裸 `Map` / `Set`（无类型参数，如 `Map` 而非 `Map<K,V>`）
- `WeakMap` / `WeakSet`（运行时无法校验，Map/Set 不复用其语义）
- Promise（运行时无法校验异步值）
- checker 无法解析的引用类型

以下情况保持 `any`（合理的不校验）：

- `unknown` — 用户显式声明不校验
- 属性无类型注解（`{ name; }`）

循环引用通过 `ref` kind 支持（不抛错），由 `generateZodSchema` 用 `z.lazy` 处理。

上层 `extractTypeInfo` / `extractAllTypes` 会 catch 并补充文件路径信息后重新抛出，方便用户定位问题。

## Map/Set 类型

`Map<K,V>` 与 `Set<T>` 在 `RuntimeType` 中分别表示为 `{ kind: 'map', key, value }` 与 `{ kind: 'set', element }`，递归解析类型参数。

### JSON 序列化约定

`Map` 与 `Set` 通过 `JSON.stringify` 会丢失数据（Map 输出 `"{}"`，Set 输出 `"[]"` 但元素信息丢失）。faapi 约定客户端按以下形式发送：

- **Map<K,V>**：以 entries 数组形式发送 `[["key", value], ...]`（与 `new Map(entries)` 兼容）
- **Set<T>**：以普通数组形式发送 `[item, ...]`（与 `new Set(array)` 兼容）

### z.preprocess 转换

生成的 zod schema 用 `z.preprocess` 在校验前把数组/对象转回 Map/Set 实例：

- `Map<K,V>` → `z.preprocess(coerceMap, z.map(keySchema, valueSchema))`
- `Set<T>` → `z.preprocess(coerceSet, z.set(elementSchema))`

`coerceMap` / `coerceSet` 与 `coerceNumber` / `coerceBoolean` 同文件，写在 outDir 根部的 `faapi-helpers.js`，按需生成（任意 zod.js 引用即生成）。

### 类型参数要求

- `Map<K,V>` 必须有 2 个类型参数；`Set<T>` 必须有 1 个类型参数
- 裸 `Map` / `Set`（无 `<...>`）抛 `SchemaExtractionError`
- `WeakMap` / `WeakSet` 仍然抛错（运行时无法枚举校验）

### coerce 模式

Map/Set 在 query/params 与 body 场景都需要 `z.preprocess`（JSON.parse 出来的是数组/对象，不是 Map/Set 实例）。`coerce=true`/`false` 均生成 preprocess 包裹，差异仅在内部 number/boolean 字段是否再包一层 coerceNumber/coerceBoolean。

## 相关模块

- `extractHandlerTypes.ts` - 调用此函数，catch 错误补充文件路径
- `../cli/collectRouteSchemaSources.ts` - 调用此函数提取类型，catch 错误补充文件路径
- `generateZodSchema.ts` - 消费 `RuntimeType` 生成 zod schema 代码
