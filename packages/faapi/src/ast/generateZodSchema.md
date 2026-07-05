# generateZodSchema

将 TypeScript AST 提取的 `RuntimeType` 转换为 [zod](https://zod.dev) schema 代码字符串。

## 为什么需要

faapi 通过 TypeScript AST 分析 handler 参数类型，生成运行时校验规则。原方案手写校验函数（`generateValidatorCode`），现改用 zod schema：

- **生态兼容**：zod 是 TypeScript 生态主流校验库，schema 可复用于前端/SDK
- **维护成本低**：复用 zod 的类型校验逻辑，不手写递归校验函数
- **错误格式标准**：ZodError 结构化，便于映射到框架的 `ValidationIssue`

## 使用场景

- `generateSchemaFiles` 为每个 handler 生成 `zod.js`，内部调用本模块生成 zod schema 代码
- 生成的代码写入 `zod.js` 文件，运行时 `import` 加载，用 `safeParse` 校验

## 类型映射

`RuntimeType` → zod schema 代码：

| RuntimeType kind | zod 代码 | 说明 |
|---|---|---|
| `string` | `z.string()` | |
| `number` | `z.number()` | |
| `boolean` | `z.boolean()` | |
| `null` | `z.null()` | |
| `undefined` | `z.undefined()` | |
| `any` / `unknown` | `z.unknown()` | 不校验 |
| `literal` | `z.literal(value)` | 字面量 |
| `array` | `z.array(element)` | 数组 |
| `tuple` | `z.tuple([e0, e1, ...])` | 元组，rest 用 `.rest()` |
| `object` | `z.object({ name: schema, ... })` | 对象，可选字段用 `.optional()` |
| `union` | `z.union([m0, m1, ...])` 或 `m0.nullable()` | 联合，含 null 时用 nullable |
| `date` | `z.coerce.date()` | 接受 string/Date，自动解析 ISO 8601 |
| `record` | `z.record(keySchema, valueSchema)` | Record<K, V> |
| `ref` | `TypeNameSchema` | 命名类型引用，跨文件 import 或本文件 const |

## 命名类型与循环引用

TypeScript interface/type alias 在 `RuntimeType` 中表示为 `{ kind: 'ref', name }`。

生成策略：
1. **收集**：遍历入口类型的 `RuntimeType`，收集所有 `ref`（命名类型引用）
2. **声明**：为每个命名类型生成 `const NameSchema = ...`（含自引用时用 `z.lazy(() => InnerSchema)` 包裹）
3. **引用**：`ref` 在代码中直接用 `NameSchema`

`z.lazy` 天然支持循环引用，无需 WeakSet 手动防护。

## 跨文件类型引用

当 handler 参数类型引用其他文件的类型时（如 `import { User } from './types'`）：
- `resolveTypeNode` 通过 TypeScript checker 解析引用符号，递归内联为完整 RuntimeType（非 `ref`）
- 因此每个 `zod.js` 自包含，无需 import 其他 `zod.js`
- `ref` 仅用于同文件内的循环引用（如 `TreeNode.children: TreeNode[]`），通过 `z.lazy` 处理

`generateZodSchemaSource` 生成自包含代码（含 `import { z } from 'zod'`）；`generateSchemaFileSource` 合并同一 handler 的多个 schema 时，剥离重复的 import 再统一添加。

## API

```ts
/** 生成单个类型的 zod schema 代码（含命名类型声明） */
function generateZodSchemaSource(
  typeInfo: HandlerTypeInfo,
  resolveType: TypeResolver,
  exportName?: string,
  coerce = false,
): string

/** RuntimeType → zod 表达式字符串（不含声明） */
function runtimeTypeToZodExpression(
  type: RuntimeType,
  ctx: CodeGenContext,
): string

/** 从 RuntimeType 收集所有命名类型（ref） */
function collectNamedTypes(
  type: RuntimeType,
  ctx: CodeGenContext,
): void

/** coerceNumber 公用函数源码（ESM export 格式，写入 faapi-helpers.js） */
const COERCE_NUMBER_HELPER: string

/** coerceBoolean 公用函数源码（ESM export 格式，写入 faapi-helpers.js） */
const COERCE_BOOLEAN_HELPER: string

/** faapi-helpers.js 文件名（生成在 outDir 根部，供各 zod.js 共享复用） */
const HELPERS_FILENAME: string

/** 生成 faapi-helpers.js 文件源码（包含 coerceNumber / coerceBoolean 两个 ESM export） */
function generateHelpersFileSource(): string

/** 检测代码是否引用了 coerceNumber / coerceBoolean 变量（决定是否生成 faapi-helpers.js） */
function usesCoerceHelpers(code: string): boolean
```

`exportName` 控制导出的 schema 变量名（默认用 `typeInfo.name`）。`validateInput` 按 `${schemaName}Schema` 查找导出，当接口名与 schemaName 不一致时（如接口名 `Query` 但 schemaName 为 `GETQuery`），需传入 `exportName` 保证一致。

`COERCE_NUMBER_HELPER` / `COERCE_BOOLEAN_HELPER` 是 coerce 公用函数的字符串源码常量，采用 ESM export 格式（`export const coerceNumber = ...` / `export const coerceBoolean = ...`），由 `generateSchemaFiles` 写入 outDir 根部的 `faapi-helpers.js`（文件名由 `HELPERS_FILENAME` 指定）。`generateHelpersFileSource()` 拼装该文件完整源码（含注释头 + 两个 export）。各 `zod.js` 通过相对路径 `import { coerceNumber, coerceBoolean } from '<相对路径>/faapi-helpers.js'` 复用同一份声明，而非每个文件内联。`usesCoerceHelpers(code)` 通过字符串包含检测代码是否引用了 `coerceNumber` / `coerceBoolean`，由 `generateSchemaFiles` 决定是否生成 `faapi-helpers.js`、由 `generateSchemaFileSource` 决定是否注入 import 语句。

## coerce 参数

`coerce` 控制是否为 query/params 场景生成字符串类型转换逻辑（默认 `false`）。

- `coerce=true`：为 `number`/`boolean` 字段（含嵌套元素，如数组元素、对象属性、元组元素）在外层包 `z.preprocess`，引用从 `faapi-helpers.js` import 的公用变量 `coerceNumber` / `coerceBoolean` 做字符串转换
- `coerce=false`：直接生成 `z.number()`/`z.boolean()`，不做字符串转换（body 场景，JSON 解析已是天然 JS 类型）

生成的 schema 通过 `z.preprocess(coerceNumber, z.number())` 引用外部公用变量，而非每个字段内联一长串函数。公用变量声明（`COERCE_NUMBER_HELPER` / `COERCE_BOOLEAN_HELPER`，ESM export 格式）由 `generateSchemaFiles` 写入 outDir 根部的 `faapi-helpers.js`（仅一份，通过 `usesCoerceHelpers` 检测是否需要生成）。`generateSchemaFileSource` 检测到 schema 引用这些变量时，在 `zod.js` 顶部注入 `import { coerceNumber, coerceBoolean } from '<相对路径>/faapi-helpers.js'`（相对路径由 `getHelpersImportPath` 按目录深度计算）。无 coerce schema 时既不生成 `faapi-helpers.js`，也不注入 import。

转换规则（公用变量实现）：

| 目标类型 | 公用变量 | 转换逻辑 |
| --- | --- | --- |
| `number` | `coerceNumber` | `typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : v`（空串/NaN 保留原值让 zod 报错，避免 `Number("") = 0` 陷阱） |
| `boolean` | `coerceBoolean` | `v === "true" \|\| v === "1" ? true : v === "false" \|\| v === "0" ? false : v`（仅这四个值转换，其他保留让 zod 报错） |

`generateSchemaFileSource` 根据 schemaName 推断 inputType：以 `Query`/`Params` 结尾 → `coerce=true`；以 `Body` 结尾 → `coerce=false`。

## 生成示例

输入：
```ts
interface GETQuery {
  page: number;
  name?: string;
}
export function GET(query: GETQuery) { return query; }
```

输出代码：
```js
import { z } from 'zod';

export const GETQuerySchema = z.object({
  page: z.number(),
  name: z.string().optional(),
});
```

循环引用示例：
```ts
interface TreeNode {
  value: number;
  children?: TreeNode[];
}
```

输出：
```js
import { z } from 'zod';

export const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    value: z.number(),
    children: z.array(TreeNodeSchema).optional(),
  }),
);
```

coerce=true 示例（query 场景）：
```ts
interface GETQuery {
  page: number;
  active?: boolean;
}
```

输出（schema 中引用公用变量，由 `generateSchemaFileSource` 在文件顶部注入 import 语句，声明在 outDir 根部的 `faapi-helpers.js`）：
```js
import { z } from 'zod';
import { coerceNumber, coerceBoolean } from '../../faapi-helpers.js';

export const GETQuerySchema = z.object({
  "page": z.preprocess(coerceNumber, z.number()),
  "active": z.preprocess(coerceBoolean, z.boolean()).optional()
});
```

> 注：`generateZodSchemaSource` 只生成 schema 表达式（含 `z.preprocess(coerceNumber, ...)` 引用），不生成 `const coerceNumber = ...` 声明，也不生成 import 语句。`faapi-helpers.js` 的生成由 `generateSchemaFiles` 通过 `usesCoerceHelpers` 检测后调用 `generateHelpersFileSource()` 完成（仅一份，写在 outDir 根部）；import 语句由 `generateSchemaFileSource` 检测到引用后注入（相对路径由 `getHelpersImportPath` 计算）。`coerce=false` 的 schema 不引用公用变量，也不会触发 helpers 文件生成或 import 注入。

## 相关模块

- [resolveTypeNode](./resolveTypeNode) — TypeScript 类型节点 → RuntimeType
- [extractHandlerTypes](./extractHandlerTypes) — 从 handler 文件提取 HandlerTypeInfo
- [generateSchemaFiles](../cli/generateSchemaFiles) — 调用本模块生成 zod.js 文件
- [validateInput](../validator/validateInput) — 运行时 import zod.js 并 safeParse
