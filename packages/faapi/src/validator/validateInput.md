# validateInput

一句话概括：校验输入参数——从 `zod.js` import zod schema，直接用 `safeParse` 校验。

## 为什么需要

根据 TypeScript interface 定义，在运行时校验输入参数，确保类型正确、必填字段存在。zod schema 由 `generateSchemaFiles` 生成到 `zod.js`（与 handler.js 同级），运行时按需 import。

**zod.js 生成时机**：

- **prod 模式**：`faapi build` 阶段全量生成 `dist/**/zod.js`，运行时直接 import
- **dev 按需模式**：启动时不预生成，首次请求时由 `createServer` 调 `ensureSchemaGenerated` 触发按需生成（详见 [compileOnDemand](../cli/compileOnDemand.md)）

## 使用场景

- 请求处理时校验 query / body / params 参数
- 返回校验结果（`ValidationResult`）和问题列表（`ValidationIssue[]`）
- dev watch 时通过 `invalidateSchemaCache` 清空模块缓存，下次请求重新 import
- dev 按需模式下 `createServer` 在 `validateInput` 之前调 `ensureSchemaGenerated` 生成 zod.js

## 校验流程

1. `getSchemaName(method, inputType)` 计算 schemaName（如 `GETQuery`）
2. `loadSchemaModule(schemaPath)` 加载 `zod.js`（带模块缓存，`importWithCacheBust` 绕过 ESM 缓存）
3. 读取 `${schemaName}Schema`（zod schema）
4. `schema.safeParse(data)` 校验
5. `mapZodIssues` 将 zod error 转为框架 `ValidationIssue`

三种状态：schema 存在 → `safeParse`；schema 为 `undefined`（无类型声明）→ 跳过校验；`zod.js` import 失败 → 抛 `InternalError`。

## 与 dev 按需模式的协作

dev 按需模式下，`createServer.handleRequest` 在调 `validateInput` 之前先调 `ensureSchemaGenerated`：

```ts
const schemaPath = getRuntimeSchemaPath(route.filePath, dist, rootDir);
if (isDevOnDemandEnabled()) {
  const devDist = getDevDist();
  if (devDist) {
    await ensureSchemaGenerated(schemaPath, route.filePath, routes, rootDir, dist);
  }
}
const result = await validateInput(schemaPath, route.method, inputType, input);
```

`ensureSchemaGenerated` 内部用 mtime 缓存判断是否需要重新生成 zod.js（首次请求生成，后续请求复用，watcher 触发时清除缓存）。

prod 模式（`isDevOnDemandEnabled()` 为 false）跳过此步骤——build 阶段已生成全部 zod.js。

## coerce 内联到 schema

query/params 来自 URL，值均为 string。类型转换（string→number/boolean）已在代码生成阶段用 `z.preprocess` 内联到 zod schema（见 `generateZodSchema` 的 `coerce` 参数），运行时直接 `safeParse` 即可，无需单独的类型转换步骤。

- `generateSchemaFileSource` 根据 schemaName 推断 inputType：以 `Query`/`Params` 结尾 → `coerce=true`；以 `Body` 结尾 → `coerce=false`（JSON 解析已是天然 JS 类型）
- `form` 注入的 schema 名仍为 `POSTBody`（与 `body` 共享 schema key，运行时无需感知 form/body 差异），但 `RouteSchemaSource.coerce=true` 显式覆盖（form 值均为 string，需 coerce）
- body schema 不含 preprocess

zod v4 issue code → 框架 `ValidationErrorCode` 映射：`invalid_type`/`invalid_union` → `TYPE_MISMATCH`；`unrecognized_keys` → `INVALID_FORMAT`；`invalid_value`/`invalid_string`/`too_small`/`too_big`/`custom` → `INVALID_VALUE`。

## 相关模块

- `schemaName.ts` - schema 命名
- `../ast/generateZodSchema.ts` - 生成 zod schema 代码（含 coerce preprocess）
- `../cli/generateSchemaFiles.ts` - 生成 zod.js
- `../cli/compileOnDemand.ts` - dev 按需生成 zod.js（`ensureSchemaGenerated`）
- `../errors/httpErrors.ts` - ValidationIssue / InternalError
