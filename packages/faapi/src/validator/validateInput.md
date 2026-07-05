# validateInput

一句话概括：校验输入参数——从 `zod.js` import zod schema，直接用 `safeParse` 校验。

## 为什么需要

根据 TypeScript interface 定义，在运行时校验输入参数，确保类型正确、必填字段存在。zod schema 由 `generateSchemaFiles` 预生成到 `zod.js`（与 handler.js 同级），运行时按需 import。

## 使用场景

- 请求处理时校验 query / body / params 参数
- 返回校验结果（`ValidationResult`）和问题列表（`ValidationIssue[]`）
- dev watch 时通过 `invalidateSchemaCache` 清空模块缓存，下次请求重新 import

## 校验流程

1. `getSchemaName(method, inputType)` 计算 schemaName（如 `GETQuery`）
2. `loadSchemaModule(schemaPath)` 加载 `zod.js`（带模块缓存，`importWithCacheBust` 绕过 ESM 缓存）
3. 读取 `${schemaName}Schema`（zod schema）
4. `schema.safeParse(data)` 校验
5. `mapZodIssues` 将 zod error 转为框架 `ValidationIssue`

三种状态：schema 存在 → `safeParse`；schema 为 `undefined`（无类型声明）→ 跳过校验；`zod.js` import 失败 → 抛 `InternalError`。

## coerce 内联到 schema

query/params 来自 URL，值均为 string。类型转换（string→number/boolean）已在代码生成阶段用 `z.preprocess` 内联到 zod schema（见 `generateZodSchema` 的 `coerce` 参数），运行时直接 `safeParse` 即可，无需单独的类型转换步骤。

- `generateSchemaFileSource` 根据 schemaName 推断 inputType：以 `Query`/`Params` 结尾 → `coerce=true`；以 `Body` 结尾 → `coerce=false`（JSON 解析已是天然 JS 类型）
- body schema 不含 preprocess

zod issue code → 框架 `ValidationErrorCode` 映射：`invalid_type`/`invalid_union` → `TYPE_MISMATCH`；`unrecognized_keys` → `INVALID_FORMAT`；`invalid_enum_value`/`invalid_string`/`too_small`/`too_big`/`custom` → `INVALID_VALUE`；`not_finite` → `COERCE_FAILED`（query 字符串转 number 失败的兜底，实际场景中 coerce 失败多报 `invalid_type`）。

## 相关模块

- `schemaName.ts` - schema 命名
- `../ast/generateZodSchema.ts` - 生成 zod schema 代码（含 coerce preprocess）
- `../cli/generateSchemaFiles.ts` - 生成 zod.js
- `../errors/httpErrors.ts` - ValidationIssue / InternalError
