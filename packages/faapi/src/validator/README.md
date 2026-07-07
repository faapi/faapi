# 输入校验

基于 TypeScript AST 提取类型信息，生成 [zod](https://zod.dev) schema，实现"类型即校验"——用户只需定义 interface，框架自动生成 zod 校验规则。

## 模块

| 模块 | 说明 |
| --- | --- |
| [validateInput.ts](./validateInput.ts) | 校验入口：import `zod.js` → zod `safeParse` |
| [schemaName.ts](./schemaName.ts) | schema 命名：`GET` + `query` → `GETQuery` |

## 架构

每个 handler 生成一个 `zod.js` 文件（与 `handler.js` 同级），包含 zod schema。运行时按需 `import` 并用 `safeParse` 校验，无需解释类型结构。

query/params 的类型转换（string→number/boolean）已在代码生成阶段用 `z.preprocess` 内联到 schema，运行时无需单独的 coerce 步骤。

```
AST 提取 → RuntimeType → generateZodSchema(coerce) → zod schema 源码
                                                              ↓
                                               每个 handler 一个 zod.js（与 handler.js 同级）
                                               dev: .faapi/dev/api/.../zod.js
                                               prd: .faapi/build/api/.../zod.js
                                                              ↓
                                                   validateInput import + safeParse
```

## schema 来源

dev 和 prd 都通过 `generateSchemaFiles` 为每个 handler 生成 `zod.js`，运行时按需 import，不降级：

| 模式 | schema 来源 | 生成时机 |
| --- | --- | --- |
| dev | `generateSchemaFiles` 生成 `.faapi/dev/**/zod.js` | 启动时全量，watch 时全量重建 |
| prd | `generateSchemaFiles` 生成 `.faapi/build/**/zod.js` | `faapi build` 时生成 |

三种状态：
- zod schema 存在：执行 `safeParse` 校验
- schema 导出 `undefined`（handler 无类型声明）：跳过校验
- `zod.js` 文件不存在或 import 失败：抛 `InternalError`

## 校验策略

```
validateInput(schemaPath, method, inputType, input)
  → import zod.js（带模块缓存，dev watch 时 invalidateSchemaCache 清空）
  → 读取 ${schemaName}Schema
  → zod schema.safeParse(data)（query/params 的 preprocess 已在 schema 生成阶段内联）
  → mapZodIssues 转 ValidationIssue
  → ValidationResult { valid, issues, data }
```

## 循环引用

zod 通过 `z.lazy(() => schema)` 延迟求值，天然支持循环引用（如 `TreeNode.children: TreeNode[]`）。生成时检测到自引用的命名类型用 `z.lazy` 包裹，无需 WeakSet 手动防护。

## coerce 内联

query/params 来自 URL，值均为 string。类型转换规则在代码生成阶段用 `z.preprocess` 内联到 zod schema：

| 目标类型 | 转换规则（z.preprocess） |
| --- | --- |
| `number` | `typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : v`（空串/NaN 保留原值，让 zod 报错，避免 `Number("") = 0` 陷阱） |
| `boolean` | `v === "true" \|\| v === "1" ? true : v === "false" \|\| v === "0" ? false : v`（仅这四个值转换，其他保留让 zod 报错） |
| `string` | 不转换 |

`generateSchemaFileSource` 根据 schemaName 推断：以 `Query`/`Params` 结尾 → `coerce=true`；以 `Body` 结尾 → `coerce=false`（body 是 JSON 解析的天然 JS 类型）。详见 `generateZodSchema` 的 `coerce` 参数。

## 相关模块

- [ast](../ast/README.md)：AST 分析，提取类型信息 + 生成 zod schema 代码（含 coerce preprocess）
- [cli/generateSchemaFiles.ts](../cli/generateSchemaFiles.ts)：为每个 handler 生成 `zod.js`
- [errors](../errors/README.md)：ValidationError / InternalError
