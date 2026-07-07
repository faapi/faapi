# generateSchemaFiles

为每个 handler 文件生成 `zod.js`，包含 zod schema。

## 为什么需要

替代原 `generateSchema.ts` 的统一 manifest 方案：
- **原方案**：所有 handler 的 schema 打包到 `.faapi/build/faapi-schema.js`，运行时加载到 schemaRegistry
- **新方案**：每个 handler 一个 `zod.js`，与 `handler.js` 同级，运行时按需 import

好处：
- 产物结构与 handler 对齐，路径更直观
- 无需 schemaRegistry 中间层
- 每个 zod.js 自包含（AST 提取时已内联跨文件类型）

## 使用场景

- `faapi dev`：生成 `.faapi/dev/api/hello/zod.js`
- `faapi build`：生成 `.faapi/build/api/hello/zod.js`
- 运行时 `validateInput` 按 route 的 schemaPath import 对应 zod.js

## 文件命名与路径

- `src/api/hello/handler.ts` → `.faapi/build/api/hello/zod.js`（与 handler.js 同级）
- 产物路径打平 src 前缀（与 compileDevRoutes / compileBuildRoutes 一致）

## zod.js 导出格式

```js
import { z } from 'zod';
import { coerceNumber, coerceBoolean } from '../../faapi-helpers.js';

// GET query schema（coerce=true：number/boolean 字段用 z.preprocess 包裹字符串转换，引用从 faapi-helpers.js import 的公用变量）
export const GETQuerySchema = z.object({
  "page": z.preprocess(coerceNumber, z.number()),
  "name": z.string().optional(),
});

// POST body schema（coerce=false：JSON 解析已是天然 JS 类型，不含 preprocess，不引用公用变量）
export const POSTBodySchema = z.object({
  name: z.string(),
  email: z.string(),
});
```

**公用函数复用**：`coerceNumber` / `coerceBoolean` 从 dist 根部的 `faapi-helpers.js` import（仅一份声明，各 zod.js 通过相对路径复用）。`generateSchemaFileSource` 在合并同一 handler 的所有 schema 后，通过 `usesCoerceHelpers` 检测 schema 代码是否引用了这些变量，若引用则在 `zod.js` 顶部注入 `import { coerceNumber, coerceBoolean } from '<相对路径>/faapi-helpers.js'`（相对路径由 `getHelpersImportPath` 按 zod.js 所在目录相对 dist 的深度计算）。schema 中通过 `z.preprocess(coerceNumber, ...)` 引用，避免每个字段内联一长串函数。`coerce=false` 的 schema 不引用公用变量，也不触发 import 注入；当整个项目无任何 coerce schema 时，`generateSchemaFiles` 也不会生成 `faapi-helpers.js` 文件。

**无类型声明的 handler**：不导出对应的 Schema（`undefined`），validateInput 检测到 undefined 跳过校验。

## 公用函数复用

coerce 公用函数（`coerceNumber` / `coerceBoolean`）提取到独立的 `faapi-helpers.js`，避免在每个含 coerce schema 的 `zod.js` 内重复声明。

**生成时机**：`generateSchemaFiles` 先为所有 handler 生成 `zod.js` 源码（暂存），再通过 `usesCoerceHelpers` 检测所有源码是否引用了 `coerceNumber` / `coerceBoolean`，若引用则在 dist 根部生成一份 `faapi-helpers.js`（调用 `generateHelpersFileSource()`，含注释头 + 两个 ESM export）。

**路径计算**：`getHelpersImportPath(relDir)` 根据 zod.js 所在目录相对 dist 的路径计算 ESM import 相对路径：

| zod.js 目录（相对 dist） | 深度 | import 路径 |
| --- | --- | --- |
| `api/hello` | 2 | `../../faapi-helpers.js` |
| `api` | 1 | `../faapi-helpers.js` |
| `""`（dist 根，理论不会发生） | 0 | `./faapi-helpers.js` |

**文件结构**：
```
.faapi/build/
├── faapi-helpers.js     ← 公用函数（仅一份，含 coerceNumber/coerceBoolean ESM export）
├── api/
│   ├── hello/
│   │   └── zod.js       ← import { coerceNumber } from '../../faapi-helpers.js'
│   └── user/
│       └── zod.js       ← import { coerceNumber } from '../../faapi-helpers.js'
```

## coerce 推断

`generateSchemaFileSource` 根据 schemaName 推断 inputType，决定是否生成 coerce 逻辑：

| schemaName 后缀 | inputType | coerce | 说明 |
| --- | --- | --- | --- |
| `Query` | query | `true` | URL 参数均为 string，number/boolean 字段需 z.preprocess 转换 |
| `Params` | params | `true` | 动态路由参数均为 string，同 query |
| `Body` | body | `false` | JSON 解析已是天然 JS 类型，无需转换 |
| `Body`（form 注入） | form | `true` | handler 声明 `form` 时 `RouteSchemaSource.coerce=true` 显式覆盖，schema 名仍为 `POSTBody`（与 body 共享运行时 schema key） |

`form` 与 `body` 共享 schema 名（`POSTBody`），运行时 `validateInput` 无需感知 form/body 差异。`collectRouteSchemaSources` 在提取时若发现 handler 声明 `form` 参数（而非 `body`），会在 `RouteSchemaSource` 上设置 `coerce=true`，`generateSchemaFileSource` 优先采用 `source.coerce`，回退到 schemaName 后缀正则。

coerce 的具体转换规则见 [generateZodSchema](../ast/generateZodSchema) 的 `coerce` 参数。

## 跨文件类型引用

`extractAllTypes` 使用 TypeScript checker 解析类型引用，跨文件类型在 AST 提取阶段已内联为完整 RuntimeType（非 `ref`）。因此每个 zod.js 自包含，无需 import 其他 zod.js。

`ref` 仅用于同文件内的循环引用（如 `TreeNode.children: TreeNode[]`），通过 `z.lazy` 处理。

## API

```ts
/** 为路由清单中每个 handler 生成 zod.js */
async function generateSchemaFiles(
  routes: RouteManifest,
  rootDir: string,
  dist: string,
): Promise<void>

/** 生成单个 handler 文件的 zod.js 源码 */
function generateSchemaFileSource(
  sources: RouteSchemaSource[],
  allTypes: Map<string, HandlerTypeInfo>,
  helpersImportPath: string,
): string

/** 计算 zod.js 到 faapi-helpers.js 的相对 import 路径 */
function getHelpersImportPath(relDir: string): string
```

`generateSchemaFileSource` 的第三个参数 `helpersImportPath` 是 zod.js 到 `faapi-helpers.js` 的相对 import 路径（如 `../../faapi-helpers.js`），由 `getHelpersImportPath(relDir)` 按 zod.js 所在目录相对 dist 的深度计算。传入空字符串表示不注入 coerce helpers 的 import（用于无 coerce schema 的文件或不支持外部 import 的测试场景）。函数内部通过 `usesCoerceHelpers` 检测 schema 代码是否引用了 `coerceNumber` / `coerceBoolean`，仅当 `helpersImportPath` 非空且检测到引用时才在顶部注入 import 语句。

`generateSchemaFiles` 的内部流程：
1. `collectRouteSchemaSources` 从路由清单提取 schema 源数据（AST 从源码 `.ts`）
2. 按 `filePath` 分组 sources
3. 为每个文件计算 `helpersImportPath`（`getHelpersImportPath`）并生成 zod.js 源码（暂存，用于检测是否需要 helpers）
4. 通过 `usesCoerceHelpers` 检测所有源码，需要时在 dist 根部生成 `faapi-helpers.js`（`generateHelpersFileSource()`）
5. 并行写入所有 zod.js

## 相关模块

- [generateZodSchema](../ast/generateZodSchema) — RuntimeType → zod schema 代码（含 coerce preprocess）
- [collectRouteSchemaSources](./collectRouteSchemaSources) — AST 提取入口
- [validateInput](../validator/validateInput) — 运行时 import zod.js 并 safeParse
- [compileDevRoutes](./compileDevRoutes) / [compileBuildRoutes](./compileBuildRoutes) — 编译 .ts → .js（zod.js 由本模块单独生成）
