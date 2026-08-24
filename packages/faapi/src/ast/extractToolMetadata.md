# extractToolMetadata

一句话概括：从 tool handler.ts 源文件提取单个 tool 的 JSDoc 描述、`@tool` 覆盖名、第一个参数的 interface 名,产出完整的 `ToolMetadata`(继承 `ToolCore` + 代码加载细节)供产物生成阶段消费。

## 为什么需要

`scanTools` 只通过正则提取了**函数导出名**(Vite 风格零 import),但生成 `faapi-tools.js` 清单和每个 tool 的 `zod.js` schema 还需要两类信息:

1. **JSDoc 描述 + `@tool` 覆盖名**——tool 名对 LLM 可见,描述让 LLM 理解 tool 用途。`@tool` 标签允许覆盖路径推导的默认名(如把 `weather.getWeather` 改为 `weather.current`)。
2. **第一个参数的 interface 名**——用于调用 `extractTypeInfo` 生成 zod schema,实现 tool 输入参数的运行时校验(与路由 body/query 同构)。

这些信息必须用 TypeScript AST 提取(JSDoc 和类型标注在运行时被擦除)。本模块在 dev/build 启动时对每个 `ToolManifest` 调用一次,把路径推导字段(name/filePath/functionName)与 AST 提取字段(description/inputTypeName)合并为完整的 `ToolMetadata`,供 [generateToolArtifacts](../cli/generateToolArtifacts.md) 直接序列化。

## Core / Metadata 分层

`ToolCore` 描述 LLM 可见字段(不含代码加载细节),`ToolMetadata` 继承 `ToolCore` 额外含代码加载细节:

- **`ToolCore`** —— `name` / `description`。描述"tool 是什么",发往 LLM 的 tool 定义只含此层字段(`name` / `description` / input schema)。`toolRegistry.getTool` 返回的 `ToolMetadata` 包含 `ToolCore` 字段。
- **`ToolMetadata extends ToolCore`** —— 额外含 `filePath`(`loadToolModule` 加载 handler.js 用) / `functionName`(源码导出函数名,AST 定位 + 运行时 resolveExport 用,不受 `@tool` 覆盖影响) / `inputTypeName`(第一个参数 interface 名,供 [extractTypeInfo](./extractHandlerTypes.md) 生成 zod schema)。仅文件型 tool 实现。

与 [extractAgentMetadata](./extractAgentMetadata.md) 的 `AgentCore` / `AgentMetadata` 分层同构——LLM-facing 字段与代码加载细节分离,便于未来扩展(如 DB-driven tool 只实现 `ToolCore` 即可)。

## 使用场景

- `faapi dev` / `faapi build` 启动时,`generateToolArtifacts` 对每个 `ToolManifest` 调 `createProgram` + `extractToolMetadata`,产出 `ToolMetadata[]` 写入 `faapi-tools.js`
- watcher 热替换时重新调用(`invalidateProgramCache` 后重新提取)
- 多个 tool 共享同一 `handler.ts` 时,每个 tool 独立调用本函数(按 `functionName` 在源文件中定位)

## 提取规则

### JSDoc 描述

从函数的 JSDoc 注释块提取 `comment` 字段(注释块内 `@tag` 之前的自由文本):

| JSDoc 形式 | 提取的 description |
|-----------|-------------------|
| `/** 获取天气 */` | `'获取天气'` |
| `/**\n * 获取天气\n * @param input 城市名\n */` | `'获取天气'`(@param 之前的首段) |
| `/** @tool x */`(无自由文本) | `undefined` |
| 无 JSDoc | `undefined` |

多行描述保留换行(TypeScript 已自动剥离每行前缀 ` * `),不做截断。

### `@tool` 覆盖名

JSDoc 中 `@tool <name>` 标签的值,覆盖路径推导的 `name`:

| JSDoc | 提取的覆盖名 | 最终 `ToolMetadata.name` |
|-------|------------|------------------------|
| `/** @tool weather.current */` | `'weather.current'` | `'weather.current'` |
| `/** @tool {weather.current} */` | `'weather.current'`(去花括号) | `'weather.current'` |
| `/** 描述 \n * @tool weather.current */` | `'weather.current'` | `'weather.current'` |
| 无 `@tool` 标签 | `undefined` | 使用 `pathMeta.name`(路径推导值) |

`@tool` 标签值缺省(只有 `@tool` 没有值)时,`ToolMetadata.name` 回退到 `pathMeta.name`(不报错,降级为路径推导值)。

> **注意**: `@tool` 只覆盖 `ToolMetadata.name`,不影响 `functionName`(源码导出名)和 `filePath`——这两个字段始终是真实路径/源码信息,用于 AST 定位和产物生成。

### 第一个参数的 interface 名

提取函数第一个参数的类型引用名(TypeReference),供 [extractTypeInfo](./extractHandlerTypes.md) 生成 zod schema:

| 函数签名 | 提取的 inputTypeName |
|---------|---------------------|
| `function getWeather(input: WeatherInput)` | `'WeatherInput'` |
| `function getWeather(input: { city: string })` | `undefined`(内联类型字面量,非 TypeReference) |
| `function getWeather(input)` | `undefined`(无类型标注) |
| `function getWeather()` | `undefined`(无参数) |
| `function getWeather(a, b)` | 第一个参数 `a` 的类型名 |

内联类型和无类型标注返回 `undefined` 而非抛错——tool 允许无参数输入(如 `function listCities()`)或无 schema 校验。是否生成 `zod.js` 由 `generateToolArtifacts` 根据 `inputTypeName` 是否为 `undefined` 决定。

## API

```ts
// LLM 可见核心字段(文件型 tool 实现,DB-driven tool 未来只实现此层)
interface ToolCore {
  name: string;             // @tool 覆盖值 或 pathMeta.name
  description?: string;      // JSDoc 描述,无 JSDoc 时 undefined
}

// 文件型 tool 完整元数据(继承 ToolCore + 代码加载细节)
interface ToolMetadata extends ToolCore {
  inputTypeName?: string;    // 第一个参数 interface 名,无/内联/无标注时 undefined
  filePath: string;          // 从 pathMeta 透传(相对路径)
  functionName: string;     // 从 pathMeta 透传(源码导出名)
}

// 路径推导的元数据(scanTools 产出)
interface ToolPathMeta {
  name: string;              // 路径推导的 tool 名(如 "weather.getWeather")
  filePath: string;          // 源码相对路径(如 "src/tools/weather/handler.ts")
}

function extractToolMetadata(
  program: ts.Program,
  filePath: string,          // 源文件绝对路径(AST 用)
  functionName: string,      // 源码导出函数名(在文件中查找的目标)
  pathMeta: ToolPathMeta,    // 路径推导的元数据(scanTools 已计算)
): ToolMetadata | null       // null: 函数未找到或源文件不在 Program 中
```

## 关键行为

- **函数查找**支持四种导出形式:`export function` / `export async function` / `export const = () =>` / `export const = async () =>`,与 [scanTools](../tools/scanTools.md) 的 `TOOL_EXPORT_RE` 正则同构
- **JSDoc 查找**对箭头函数/函数表达式自动回溯到外层 `VariableStatement`(JSDoc 写在 `export const` 上方)
- **无 try/catch**——AST 异常(如 `SchemaExtractionError` 来自下游 `extractTypeInfo`)向上传播,依赖调用方处理
- **不调用 `extractTypeInfo`**——本模块只提取类型名,不解析类型结构(由 `generateToolArtifacts` 调用 `extractTypeInfo` 完成完整解析)

## 相关模块

- [scanTools](../tools/scanTools.md) - 产出 `ToolManifest`(含 `functionName`),供本模块的 `pathMeta` 来源
- [toolTypes](../tools/toolTypes.md) - `ToolManifest` 类型定义
- [createProgram](./createProgram.md) - 创建 TypeScript Program
- [extractHandlerTypes](./extractHandlerTypes.md) - 下游消费 `inputTypeName` 提取完整类型结构
- [generateToolArtifacts](../cli/generateToolArtifacts.md) - 下游消费 `ToolMetadata[]` 生成 `faapi-tools.js` + `zod.js`
- [toolRegistry](../injection/toolRegistry.md) - `getTool` 返回 `ToolMetadata`(含 `ToolCore` 字段),供 agent 运行时按名查找
- [extractAgentMetadata](./extractAgentMetadata.md) - agent 元数据提取(对称设计参考,同样有 `AgentCore`/`AgentMetadata` 分层)
- [analyzeInjection](../injection/analyzeInjection.md) - 路由 handler 参数提取(对称设计参考)
