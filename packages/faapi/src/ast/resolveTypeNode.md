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
| 数组 | `T[]` / `Array<T>` | |
| 元组 | `[string, number]` / `[string, number?]` / `[string, ...number[]]` | 按位置校验 |
| 对象 | `{ name: string }` / `interface` | |
| 联合 | `string \| null` | |
| 交叉 | `A & B` | 按对象合并 |
| 引用 | `Date` / 自定义 interface | Date 允许 Date 实例或 ISO 8601 字符串 |
| 工具 | `Record<K,V>` / `Partial<T>` / `Pick<T,K>` / `Omit<T,K>` | |
| 枚举 | `enum Role { Admin = 'admin' }` | 转为字面量联合 |

## 错误策略

为避免"静默降级为 any"导致用户不知情，遇到以下情况抛 `SchemaExtractionError`：

- 无法识别的语法节点
- `any` / `void` / `never` / `object`（显式声明应使用 `unknown` 表示不校验）
- `bigint` — HTTP/JSON 不能传输，请改用 `string` 或 `number`
- `symbol` — HTTP/JSON 不能传输
- `Function` — HTTP/JSON 不能传输
- Pick/Omit 的 T 不是 object 类型
- Pick/Omit 的 K 无法解析为字面量集合
- Map / Set / WeakMap / WeakSet（运行时无法校验）
- Promise（运行时无法校验异步值）
- checker 无法解析的引用类型

以下情况保持 `any`（合理的不校验）：

- `unknown` — 用户显式声明不校验
- 属性无类型注解（`{ name; }`）

循环引用通过 `ref` kind 支持（不抛错），由 `generateValidatorCode` 检测必填直接循环引用并抛错。

上层 `extractTypeInfo` / `extractAllTypes` 会 catch 并补充文件路径信息后重新抛出，方便用户定位问题。

## 相关模块

- `extractHandlerTypes.ts` - 调用此函数，catch 错误补充文件路径
- `generateSchema.ts` - 调用此函数，catch 错误补充文件路径
- `generateValidatorCode.ts` - 消费 `RuntimeType` 生成校验函数
