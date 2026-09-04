# generateToolArtifacts

一句话概括：把 [scanTools](../tools/scanTools.md) 产出的 `ToolManifest[]` 经 [extractToolMetadata](../ast/extractToolMetadata.md) AST 增强，序列化为 `faapi-tools.js` 清单 + 为每个含输入类型的 tool 生成 `zod.js`，运行时由 `toolRegistry` 水合还原。

## 为什么需要

生产模式不应重新扫描文件系统（生产环境无需 glob）。dev/build 时把 tool 元数据序列化为 `<dist>/faapi-tools.js`，运行时 `createAppCore` import 读取并水合为 `ToolMetadata[]` 喂给 `toolRegistry`（与 [generateRoutes](./generateRoutes.md) 的 `faapi-routes.js` 对称）。

序列化的 tool 元数据包含两类信息：

1. **路径推导字段**（来自 `scanTools` 的 `ToolManifest`）：`name` / `functionName` / `filePath`
2. **AST 提取字段**（来自 `extractToolMetadata`）：`description`（JSDoc 描述，对 LLM 可见）/ `inputTypeName`（第一个参数 interface 名，用于生成 zod schema）

## 使用场景

- `faapi dev`：`generateToolArtifacts` 生成 `.faapi/faapi-tools.js`（**仅清单，不预生成 zod.js**——zod.js 在首次请求时由 `ensureToolSchemaGenerated` 按需生成，与 [compileOnDemand](./compileOnDemand.md) 同源思想）
- `faapi build`：`generateToolArtifacts` 生成 `dist/faapi-tools.js` + 每个 tool 的 `zod.js`（全量预生成，prod 启动时按需 import）
- `node dist/main`（prod）：`createAppCore` import 读取 `dist/faapi-tools.js` → `hydrateTools` 还原 `ToolMetadata[]` → 喂给 `toolRegistry`
- 首次请求：`agentRegistry` / `toolRegistry` 按需 import `zod.js` 做 zod `safeParse`（agent 调用 tool 前的输入校验）

## 序列化策略

- `filePath`：源码形式（`src/tools/weather/handler.ts`）→ 产物形式（`<dist>/tools/weather/handler.js`，打平 `src/` 前缀 + dist 前缀 + `.js`）
- `description` / `inputTypeName`：AST 提取的字符串字段，直接序列化（无函数引用）
- `name` / `functionName`：字符串字段，直接序列化

## 水合策略

- `hydrateTools` 把 `SerializedToolRecord[]` 还原为 `ToolMetadata[]`，字段一一对应（无函数引用需还原）
- 水合后 `filePath` 是产物形式（`<dist>/tools/weather/handler.js`），运行时直接用于 import tool.js
- `toolRegistry` 持有 `ToolMetadata[]`，提供 `getTool(name)` / `listTools()`

## 文件命名与路径

### faapi-tools.js 路径

- dev：`.faapi/faapi-tools.js`
- prod：`dist/faapi-tools.js`

### tool 的 zod.js 路径

每个 tool handler 目录下生成一个 `zod.js`（与 `handler.js` 同级，basename 固定为 `zod.js`，与路由的 zod.js 同构）：

| 源码路径 | 产物路径 |
| --- | --- |
| `src/tools/weather/handler.ts` | `<dist>/tools/weather/zod.js` |
| `src/tools/handler.ts` | `<dist>/tools/zod.js` |

产物路径打平 `src/` 前缀（与 `compileDevRoutes` / `compileBuildRoutes` 一致）。

### 运行时 zod.js 路径计算

`getRuntimeToolSchemaPath(filePath, dist, rootDir)` 从 `tool.filePath`（产物形式）计算 zod.js 绝对路径：
- 去掉 `<dist>/` 前缀
- 取目录部分，basename 固定为 `zod.js`
- join `<rootDir>/<dist>`

## faapi-tools.js 导出格式

```js
// 自动生成,请勿手动编辑(faapi build/dev 产物)
export const tools = [
  {
    "name": "weather.getWeather",
    "functionName": "getWeather",
    "description": "获取指定城市的天气", // JSDoc 描述,无 JSDoc 时省略字段
    "inputTypeName": "WeatherInput",  // 第一个参数 interface 名,无参数时省略字段
    "filePath": "dist/tools/weather/handler.js"  // 产物形式(打平 src/ 前缀)
  },
  {
    "name": "ping",
    "functionName": "ping",
    "filePath": "dist/tools/handler.js"
    // 无 description / inputTypeName,字段省略(JSON.stringify 自动忽略 undefined)
  }
];
```

`undefined` 字段在 JSON.stringify 时自动省略，水合时通过 `??` 兜底为 undefined。

## tool 的 zod.js 导出格式

```js
import { z } from 'zod';
import { coerceMap, coerceSet } from '../../faapi-helpers.js';

// WeatherInput schema（coerce=false：tool input 来自 LLM JSON 调用，已是天然 JS 类型）
export const WeatherInputSchema = z.object({
  city: z.string(),
});
```

### schema 名规则

`<inputTypeName>Schema`——直接用 `inputTypeName` 加 `Schema` 后缀。运行时 `toolRegistry` 按 `${inputTypeName}Schema` 从 zod.js 查找。

> 与路由的 schema 名规则（`<METHOD><InputType>Schema`，如 `GETQuerySchema`）不同——tool 没有 HTTP 方法维度，schema 名直接取自参数类型名。

### coerce 策略

| 字段类型 | coerce | 说明 |
| --- | --- | --- |
| 顶层 input schema | `false` | tool input 来自 LLM JSON 调用（OpenAI tool call arguments 是 JSON 字符串，JSON.parse 后是天然 JS 类型），与 body 类似，无需字符串转换 |
| Map/Set 字段 | `z.preprocess` 包裹 | JSON.parse 出来的是数组/对象，需还原为 Map/Set 实例（与 body 场景一致） |

`coerce=false` 时不引用 `coerceNumber` / `coerceBoolean`；Map/Set 字段在两种场景下都引用 `coerceMap` / `coerceSet`。

### 公用函数复用

`coerceMap` / `coerceSet` 从 dist 根部的 `faapi-helpers.js` import（与 [generateSchemaFiles](./generateSchemaFiles.md) 共享同一份产物，**不重新生成**）。`generateToolArtifacts` 通过 `usesCoerceHelpers` 检测 tool zod.js 是否引用公用变量，若引用则注入 import 语句——但 **helpers 文件本身由 `generateSchemaFiles` 在路由 schema 生成阶段统一生成**（与 faapi-routes/faapi-tools 同源思想：每个产物类型各司其职，helpers 是跨路由/tool 共享的公用产物）。

> 若项目只有 tool schema 引用 `coerceMap` / `coerceSet`（无路由 schema），`generateToolArtifacts` 仍需在 dist 根部生成 `faapi-helpers.js`——通过独立的 `maybeGenerateHelpers` 函数处理（仅当检测到引用且文件不存在时生成）。

### 无 inputTypeName 的 tool

无参数 / 参数无类型标注 / 参数为内联类型字面量的 tool 不生成 zod.js（与路由的"无类型声明的方法不导出 Schema"对齐）。运行时 `toolRegistry` 检测到 `inputTypeName === undefined` 跳过 schema 校验，直接传 `undefined` 调用 tool。

## API

```ts
/** 序列化 tool 清单为可写入 JS 模块的结构（filePath 转产物形式） */
function serializeTools(
  tools: ToolMetadata[],
  dist?: string,                    // 默认 'dist'
): SerializedToolRecord[]

/** 把序列化清单写入 faapi-tools.js */
async function writeToolsModule(
  manifest: SerializedToolRecord[],
  outputPath: string,
): Promise<void>

/** 从序列化清单水合还原 ToolMetadata[] */
function hydrateTools(manifest: SerializedToolRecord[]): ToolMetadata[]

/** 主入口：扫描清单 + AST 增强 + 生成 faapi-tools.js + 每个 tool 的 zod.js */
async function generateToolArtifacts(
  tools: ToolManifest[],            // scanTools 产出
  rootDir: string,
  dist: string,                     // '.faapi' 或 'dist'
  options?: {
    /** 跳过 zod.js 生成（dev 模式按需生成,启动时仅生成清单） */
    skipSchema?: boolean;
  },
): Promise<ToolMetadata[]>          // 返回 AST 增强后的完整元数据（供调用方日志/调试）

/** 源码路径 → tool zod.js 产物路径 */
function getToolSchemaOutputPath(sourceFile: string, dist: string, rootDir: string): string

/** 运行时从 tool.filePath（产物形式）计算 zod.js 绝对路径 */
function getRuntimeToolSchemaPath(filePath: string, dist: string, rootDir: string): string

/** 生成单个 tool handler.ts 的 zod.js 源码（dev 按需生成时复用） */
function generateToolSchemaFileSource(
  sources: ToolSchemaSource[],
  resolveType: (name: string) => RuntimeType | undefined,
  helpersImportPath: string,
): string
```

### SerializedToolRecord

```ts
interface SerializedToolRecord {
  name: string;
  functionName: string;
  description?: string;
  inputTypeName?: string;
  filePath: string;          // 产物形式(打平 src/ 前缀 + dist 前缀 + .js)
}
```

字段一一对应 `ToolMetadata`，仅 `filePath` 由源码形式转为产物形式。

### ToolSchemaSource

```ts
interface ToolSchemaSource {
  /** tool 名（含 @tool 覆盖）,用作注释标识 */
  name: string;
  /** 源文件绝对路径（用于按文件分组生成 zod.js） */
  filePath: string;
  /** schema 名 = inputTypeName（导出 `${inputTypeName}Schema`） */
  schemaName: string;
  /** AST 提取的类型信息,null 时不导出 Schema */
  typeInfo: HandlerTypeInfo | null;
}
```

## 内部流程

`generateToolArtifacts` 主入口流程：

1. 批量 `createPrograms`（全部 tool 文件共享同一个 Program）+ 逐个 `extractToolMetadata` → `ToolMetadata[]`（含 AST 字段）
2. `serializeTools(metadata, dist)` → `SerializedToolRecord[]`（filePath 转产物形式）
3. `writeToolsModule(serialized, faapiToolsPath)` → 写入 `<dist>/faapi-tools.js`
4. 若 `skipSchema=true`（dev 按需模式）→ 返回，不生成 zod.js
5. `collectToolSchemaSources` 从 `ToolMetadata[]` 收集 schema 源数据（按文件分组）
6. 为每个文件计算 `helpersImportPath` + 生成 zod.js 源码（暂存）
7. `usesCoerceHelpers` 检测是否需要 helpers，需要时 `maybeGenerateHelpers` 生成/复用 `faapi-helpers.js`
8. 并行写入所有 zod.js

## dev 模式按需生成

dev 启动时 `generateToolArtifacts(skipSchema: true)` 只生成 `faapi-tools.js`，不预生成 zod.js。首次 agent 调用 tool 时由 `ensureToolSchemaGenerated`（阶段 1.4）按需生成单文件 zod.js（与 `ensureSchemaGenerated` 同构，复用 mtime 缓存策略）。

## 相关模块

- [scanTools](../tools/scanTools.md) — 产出 `ToolManifest[]`（仅路径推导字段），作为本模块输入
- [extractToolMetadata](../ast/extractToolMetadata.md) — AST 增强 `ToolManifest` → `ToolMetadata`（含 description/inputTypeName）
- [generateSchemaFiles](./generateSchemaFiles.md) — 路由 schema 生成（与本模块对称设计，复用 faapi-helpers.js）
- [generateZodSchema](../ast/generateZodSchema.md) — RuntimeType → zod schema 代码
- [createProgram](../ast/createProgram.md) — TypeScript Program（带缓存，批量走 `createPrograms` 共享）
- [extractHandlerTypes](../ast/extractHandlerTypes.md) — `extractTypeInfo` / `createLazyTypeResolver` 类型提取（惰性解析）
- [generateSchemaFiles.ts](./generateSchemaFiles.md) — `getToolSchemaOutputPath` / `getRuntimeToolSchemaPath` 为其同规则函数的别名 re-export
- [../utils/prodPaths.md](../utils/prodPaths.md) — `toProdFilePath` 产物路径转换（单一来源）
- [generateRoutes](./generateRoutes.md) — `faapi-routes.js` 路由清单序列化（与本模块同构）
- [compileOnDemand](./compileOnDemand.md) — dev 按需编译/生成（阶段 1.4 复用）
- [toolRegistry](../injection/toolRegistry.md) — 运行时 tool 注册表（消费水合后的 `ToolMetadata[]`）
- [createAppCore](./createAppCore.md) — prod 启动时水合 `faapi-tools.js` 到 `toolRegistry`
