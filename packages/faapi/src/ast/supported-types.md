# AST 支持的 TypeScript 类型清单

本文档列出 faapi AST 类型提取支持/不支持的 TypeScript 语法，方便用户提前了解边界。

> 解析逻辑在 `resolveTypeNode.ts`，遇到不支持的语法抛 `SchemaExtractionError`（不静默降级为 `any`），由 `extractHandlerTypes.ts` 补充文件路径后重新抛出。

## 支持的类型

### 基础类型

| TypeScript 类型 | RuntimeType kind | 说明 |
| --- | --- | --- |
| `string` | `string` | |
| `number` | `number` | query/params 场景自动 coerce |
| `boolean` | `boolean` | query/params 场景自动 coerce |
| `null` | `null` | |
| `undefined` | `undefined` | 通常作为可选字段标记 |
| `unknown` | `any` | 显式声明不校验（唯一允许的"放行"类型） |

### readonly 修饰符

readonly 是 TypeScript 的编译期约束，运行时不产生校验语义，AST 提取阶段统一忽略修饰符，按底层类型解析。

| TypeScript 类型 | RuntimeType kind | 说明 |
| --- | --- | --- |
| `readonly id: string`（字段修饰符） | 同底层类型 | 字段级 readonly，忽略修饰符 |
| `ReadonlyArray<T>` | `array` | 等同 `Array<T>` |
| `readonly T[]` | `array` | 等同 `T[]` |
| `readonly [T, U]` | `tuple` | 等同 `[T, U]` |

### 字面量类型

| TypeScript 类型 | RuntimeType kind |
| --- | --- |
| `'foo'`（字符串字面量） | `literal` |
| `42`（数字字面量） | `literal` |
| `true` / `false` | `literal` |
| `null`（字面量位置） | `null` |

### 复合类型

| TypeScript 类型 | RuntimeType kind | 说明 |
| --- | --- | --- |
| `T[]` | `array` | |
| `Array<T>` | `array` | |
| `[string, number]` | `tuple` | 按位置校验 |
| `[string, number?]` | `tuple` | 可选元素 |
| `[string, ...number[]]` | `tuple` | 剩余元素 |
| `[name: string]` | `tuple` | 命名元组成员 |
| `A \| B` | `union` | |
| `A & B` | `object` | 合并属性 |
| `{ name: string }` | `object` | 内联对象 |
| `{ [key: string]: T }` | `record` | 索引签名 |

### 工具类型与引用

| TypeScript 类型 | RuntimeType kind | 说明 |
| --- | --- | --- |
| `keyof T` | `union` | 字面量联合 |
| `Date` | `date` | 允许 Date 实例或 ISO 8601 字符串 |
| `Record<K, V>` | `record` | |
| `Partial<T>` | `object` | 所有字段变 optional |
| `Required<T>` | 内部类型 kind | best effort，直接返回内部类型 |
| `Readonly<T>` | 内部类型 kind | best effort，直接返回内部类型 |
| `Pick<T, K>` | `object` | 筛选字段；K 支持字面量联合、类型别名、`keyof T` |
| `Omit<T, K>` | `object` | 排除字段；K 支持字面量联合、类型别名、`keyof T` |
| type 别名 | 递归解析 | |
| interface（含 `extends` 继承） | `object` | 合并父接口属性 |
| `enum`（字符串/数值枚举） | `union` | 字面量联合；隐式数值枚举递增 |
| 自引用 / 循环引用 | `ref` | 由 `generateZodSchema` 用 `z.lazy(() => ...)` 处理 |
| 跨文件类型引用（import） | checker 内联 | 每个 `zod.js` 自包含，无需跨文件 import |

## 不支持的类型（抛 SchemaExtractionError）

以下类型在解析时抛 `SchemaExtractionError`，避免静默降级为 `any`。开发时遇到这些错误应修改类型声明。

| TypeScript 类型 | 错误原因 | 建议 |
| --- | --- | --- |
| `any` | 显式声明应使用 `unknown` 表示不校验 | 改用 `unknown` |
| `void` | 不支持运行时校验 | 不要在 query/body 类型中使用 |
| `never` | 不支持运行时校验 | 不要在 query/body 类型中使用 |
| `object`（关键字） | 不支持，请使用具体对象类型或 `unknown` | 改用具体 interface 或 `unknown` |
| `bigint` | 无法通过 HTTP/JSON 传输 | 改用 `string` 或 `number` |
| `symbol` | 无法通过 HTTP/JSON 传输 | 不要在 query/body 类型中使用 |
| `Map<K,V>` / `Set<T>` / `WeakMap` / `WeakSet` | 运行时无法校验 | 改用对象或数组 |
| `Promise<T>` | 运行时无法校验异步值 | 不要在 query/body 类型中使用 |
| `Function` | 无法通过 HTTP/JSON 传输 | 不要在 query/body 类型中使用 |
| 函数类型（`() => void` 等） | 无法识别的语法节点 | 不要在 query/body 类型中使用 |
| 自定义 class 声明 | checker 无法解析为 interface/type | 改用 interface 或 type 别名声明 |
| Pick/Omit 的 T 非 object | 无法筛选字段 | T 必须是对象类型 |
| Pick/Omit 的 K 无法解析 | 无法确定字段集合 | K 用字面量联合或 `keyof T` |
| enum 成员初始化值非 string/number | 仅支持 string/number 字面量 | 枚举值用 string 或 number |
| 无法识别的语法节点 | AST 不支持 | 简化类型语法 |

## coerce 机制

query/params 来自 URL 值均为 string，类型转换在代码生成阶段用 `z.preprocess` 内联到 schema：

- `number` 字段 → `z.preprocess(coerceNumber, z.number())`（空串/NaN 时返回原值，zod safeParse 报错）
- `boolean` 字段 → `z.preprocess(coerceBoolean, z.boolean())`（`'true'`/`'1'` → true，`'false'`/`'0'` → false）
- 嵌套类型（array/object/tuple/union 内部的 number/boolean）也会被包裹

判定规则：schemaName 以 `Query` 或 `Params` 结尾 → `coerce=true`；以 `Body` 结尾 → `coerce=false`（JSON 解析已是天然 JS 类型）。

公用 `coerceNumber` / `coerceBoolean` 提取到 outDir 根部的 `faapi-helpers.js`（仅一份，ESM export），各 `zod.js` 通过相对路径 import 复用。无 coerce schema 时不生成该文件。

## JSDoc 约束标签

通过字段级 JSDoc 注释声明运行时约束，AST 提取阶段解析后内联到 zod schema 链式调用。约束与字段类型不匹配时抛 `SchemaExtractionError`（不静默忽略）。

### 数值约束（仅 number 字段）

| 标签 | 示例 | zod 生成 |
| --- | --- | --- |
| `@max N` | `@max 100` | `z.number().max(100)` |
| `@min N` | `@min 0` | `z.number().min(0)` |
| `@int` | `@int` | `z.number().int()` |
| `@positive` | `@positive` | `z.number().positive()` |
| `@negative` | `@negative` | `z.number().negative()` |
| `@nonnegative` | `@nonnegative` | `z.number().nonnegative()` |
| `@nonpositive` | `@nonpositive` | `z.number().nonpositive()` |

### 长度约束（string 或 array 字段）

| 标签 | 示例 | zod 生成（string） | zod 生成（array） |
| --- | --- | --- | --- |
| `@maxLength N` | `@maxLength 50` | `z.string().max(50)` | `z.array(...).max(50)` |
| `@minLength N` | `@minLength 1` | `z.string().min(1)` | `z.array(...).min(1)` |
| `@length N` | `@length 8` | `z.string().length(8)` | `z.array(...).length(8)` |

### 字符串格式约束（仅 string 字段）

| 标签 | 示例 | zod 生成 |
| --- | --- | --- |
| `@regex /pattern/flags` | `@regex /^[a-z]+$/i` | `z.string().regex(/^[a-z]+$/i)` |
| `@pattern /pattern/flags` | 同 @regex | 同 @regex（别名） |
| `@email` | `@email` | `z.string().email()` |
| `@url` | `@url` | `z.string().url()` |
| `@uuid` | `@uuid` | `z.string().uuid()` |

### 使用规则

- **作用位置**：仅 interface / type 别名的字段级 JSDoc 注释生效；嵌套类型（array 元素、tuple 元素、union 成员）的注释不解析。
- **类型校验**：约束标签与字段类型不匹配时抛 `SchemaExtractionError`，复用现有错误（不新增错误类型）。例如 `@max 100` 用于 `string` 字段会抛错。
- **组合使用**：多个标签可叠加，按声明顺序生成链式调用。如 `@min 0 @max 100` → `z.number().min(0).max(100)`。
- **值解析**：`@max`/`@min`/`@maxLength`/`@minLength`/`@length` 后必须是数字字面量；`@regex`/`@pattern` 后必须是 `/pattern/flags` 形式；其他标签无值。
- **coerce 兼容**：query/params 场景 `@max` 等约束在 `z.preprocess` 包裹的最外层 zod 链上生效，不影响 coerce 行为。

### 示例

```ts
export interface GETQuery {
  /**
   * 页码，从 1 开始
   * @min 1
   * @max 1000
   * @int
   */
  page: number;
  /**
   * 用户名，3-20 字符
   * @minLength 3
   * @maxLength 20
   * @regex /^[a-zA-Z0-9_]+$/
   */
  username: string;
  /**
   * 邮箱
   * @email
   */
  email: string;
  /**
   * 标签列表，最多 10 个
   * @maxLength 10
   */
  tags: string[];
}
```

## 相关模块

- [resolveTypeNode.ts](./resolveTypeNode.ts) - 类型节点解析为 RuntimeType
- [extractHandlerTypes.ts](./extractHandlerTypes.ts) - 提取 interface 类型信息
- [generateZodSchema.ts](./generateZodSchema.ts) - RuntimeType → zod schema 代码
- [generateSchemaFiles.ts](../cli/generateSchemaFiles.ts) - 为每个 handler 生成 `zod.js`
- [README.md](./README.md) - AST 模块概述
