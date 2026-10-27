# extractToolMetadata

一句话概括：从 tool handler.ts 源文件提取单个 tool 的 JSDoc 描述、第一个参数的 interface 名,产出完整的 `ToolMetadata`(继承 `ToolCore` + 代码加载细节)供产物生成阶段消费。

## 为什么需要

`scanTools` 只通过正则提取了**函数导出名**(Vite 风格零 import),但生成 `faapi-tools.js` 清单和每个 tool 的 `zod.js` schema 还需要两类信息:

1. **JSDoc 描述**——tool 名由目录路径 + 函数名推导,描述让 LLM 理解 tool 用途。
2. **第一个参数的 interface 名**——用于调用 `extractTypeInfo` 生成 zod schema,实现 tool 输入参数的运行时校验(与路由 body/query 同构)。

这些信息必须用 TypeScript AST 提取(JSDoc 和类型标注在运行时被擦除)。本模块在 dev/build 启动时对每个 `ToolManifest` 调用一次,把路径推导字段(name/filePath/functionName)与 AST 提取字段(description/inputTypeName)合并为完整的 `ToolMetadata`,供 [generateToolArtifacts](../cli/generateToolArtifacts.md) 直接序列化。

## Core / Metadata 分层

`ToolCore` 描述 LLM 可见字段(不含代码加载细节),`ToolMetadata` 继承 `ToolCore` 额外含代码加载细节:

- **`ToolCore`** —— `name` / `description`。描述"tool 是什么",发往 LLM 的 tool 定义只含此层字段(`name` / `description` / input schema)。`toolRegistry.getTool` 返回的 `ToolMetadata` 包含 `ToolCore` 字段。
- **`ToolMetadata extends ToolCore`** —— 额外含 `filePath`(`loadToolModule` 加载 handler.js 用) / `functionName`(源码导出函数名,AST 定位 + 运行时 resolveExport 用) / `inputTypeName`(第一个参数 interface 名,供 [extractTypeInfo](./extractHandlerTypes.md) 生成 zod schema)。仅文件型 tool 实现。

分层设计——LLM-facing 字段与代码加载细节分离,便于未来扩展(如 DB-driven tool 只实现 `ToolCore` 即可)。agent 侧对应分层见主包 [agentTypes](../agents/agentTypes.md)（`AgentCore` / `AgentMetadata`）。

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
| `/** @see x */`(无自由文本) | `undefined` |
| 无 JSDoc | `undefined` |

多行描述保留换行(TypeScript 已自动剥离每行前缀 ` * `),不做截断。

### 残留 `@tool` 覆盖名标签（抛错）

tool 名统一由目录路径 + 函数名推导（嵌套段用 `_` 连接），保证「目录路径 + 函数名 → 注册名」映射单射，`@tool` 覆盖语义不存在。函数 JSDoc 中出现**有值的 `@tool` 标签**时，AST 提取阶段抛 `SchemaExtractionError`：

```
tool 名由目录路径 + 函数名推导（嵌套段用 _ 连接），JSDoc 不提供名字覆盖——残留 `@tool` 标签静默忽略。
删除 @tool JSDoc 标签；需要不同名字时改名目录或函数
```

无值的裸标签（`/** @tool */`）不构成残留，维持回退语义不报错。

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

### 第二个参数的 ctx 校验类型名（ctxTypeName）

提取函数第二个参数的**业务校验类型名**，供运行时对合成 ctx 做「声明即校验」（语义见 [agentToolContext](../runtime/agentToolContext.md) 的「tool ctx 声明即校验」）。第二参的合法形态与提取结果：

| 函数签名（第二参） | 提取的 ctxTypeName |
|-------------------|-------------------|
| `ctx: OrderCtx` | `'OrderCtx'` |
| `ctx: OrderCtx & AgentToolContext` | `'OrderCtx'`（交叉拆分：跳过 `AgentToolContext` 侧——框架字段由运行时注入，不校验；业务侧唯一成员为校验类型） |
| `ctx: WriterToolContext`，且 `type WriterToolContext = WriterToolCtx & AgentToolContext` | `'WriterToolCtx'`（**命名别名解引用**：别名声明指向含框架侧成员的交叉时拆分——唯一具名业务成员取业务名，与内联交叉标注同路径同 schema 名） |
| `ctx: Combined`，且别名 = `A & B & AgentToolContext` | `'Combined'`（**默认名 = 别名名**：多业务成员无唯一业务名，下游 `extractCtxTypeInfo` 剥离框架侧逐成员解析合并，生成 `CombinedSchema`） |
| `ctx: X`，且别名 = `{ userId: number } & AgentToolContext` | `'X'`（默认名 = 别名名：内联业务成员经 `extractCtxTypeInfo` 剥离框架侧后生成 schema） |
| `ctx: Ctx`，且别名 = `A & { b: 1 } & AgentToolContext`（具名+内联混合成员） | `'Ctx'`（默认名 = 别名名：剥离解析合并全部非框架侧成员，不丢内联字段） |
| `ctx: Ctx`，且别名 = `AgentToolContext & AgentToolContext`（仅框架侧） | `undefined`（无业务成员可校验——对齐裸标注语义） |
| `ctx: Combined`，且别名 = `A & B`（无框架侧成员） | `'Combined'`（**不解引用**：无框架字段时别名整体可被 extractTypeInfo 解析合并，拆分反而丢成员） |
| `ctx: AgentToolContext`（裸标注） | `undefined`（只要框架注入字段，无业务校验类型——对齐交叉分支「业务侧全为框架侧 → undefined」语义，不生成 schema） |
| `ctx: { userId: number } & AgentToolContext`（内联标注） | `'getOrderCtx'`（**默认名 = \`${函数名}Ctx\`**：剥离框架侧生成 schema） |
| `ctx: A & B & AgentToolContext`（内联标注） | `'getOrderCtx'`（默认名 = 函数名 Ctx：剥离框架侧合并 A、B） |
| `ctx: { userId: number }`（纯内联） | `'getOrderCtx'`（默认名 = 函数名 Ctx：整标注解析生成 schema——内联不再意味着不校验） |
| `ctx: AgentToolContext & AgentToolContext`（内联仅框架侧） | `undefined`（无业务成员可校验） |
| `ctx: unknown` / `ctx: string` 等关键词标注 | `undefined`（关键词类型无字段可校验，向后兼容；`ctx: A & string` 等混合交叉会在解析期因非 object 成员显式抛错） |
| `ctx`（无标注）/ 无第二参 | `undefined`（无 schema 无校验，向后兼容） |

**默认名规则（合成名）**：业务侧无法唯一具名时（多成员/内联字面量/混合），schema 名取**别名名**（别名形态）或**`${函数名}Ctx`**（纯标注形态）。合成名与文件内已有类型声明同名时**构建期抛错**（fail-fast：请为校验类型命名或重命名，避免 schema 被同名声明劫持）。解析侧（[extractCtxTypeInfo](./extractHandlerTypes.md)）按第二参标注形态重新判定内联性——同名声明搜不到才走内联回退，因此合成名永不与真实声明混淆。

命名别名解引用的查找范围：标注名先查 handler.ts 本文件的顶层 type alias 声明，查不到再回退 program 其他源文件（跳过 node_modules / TypeScript lib，与 extractTypeInfo 的跨文件回退同构）；同名 interface / enum 声明不是别名，不解引用，维持 TypeReference 直取语义。解引用结果：**唯一非框架侧成员且为具名 TypeReference** → 取业务名（普通 extractTypeInfo 路径）；**否则** → 默认名（别名名），下游 `extractCtxTypeInfo` 剥离解析——跳过框架侧成员，逐成员解析（TypeReference 与内联字面量均可）合并为单 schema，非 object 成员 / 同名字段冲突显式抛错。命名约定仍是「schema 导出名 = ctxTypeName」。interface extends AgentToolContext 不在支持范围（语义见 [agentToolContext](../runtime/agentToolContext.md)——业务校验类型携带框架字段以交叉标注为唯一形态）。

`AgentToolContext` 侧按类型名匹配跳过——它是框架注入字段（tasks/log/signal）的载体，运行时恒有且非纯数据，进 schema 无意义（extends 直接使用会因 `import('...').TaskClient` 类型语法构建期抛错，业务校验类型携带框架字段仍以交叉标注为唯一形态；只要框架字段不要业务校验时裸标注即合法）。业务校验类型内声明与框架字段同名的属性（如 `log: string`）不特殊处理——运行时校验失败显式暴露，属业务声明与框架注入的名字冲突。

`ctxTypeName` 随清单序列化（`faapi-tools.js`），运行时 `executeToolCall` 据此解析同文件 `zod.js` 的 `${ctxTypeName}Schema` 做 safeParse。

## API

```ts
// LLM 可见核心字段(文件型 tool 实现,DB-driven tool 未来只实现此层)
interface ToolCore {
  name: string;             // pathMeta.name（目录路径 + 函数名推导,嵌套段用 _ 连接）
  description?: string;      // JSDoc 描述,无 JSDoc 时 undefined
}

// 文件型 tool 完整元数据(继承 ToolCore + 代码加载细节)
interface ToolMetadata extends ToolCore {
  inputTypeName?: string;    // 第一个参数 interface 名,无/内联/无标注时 undefined
  ctxTypeName?: string;      // 第二个参数业务校验类型名(交叉类型拆分 AgentToolContext 侧后),无/内联/裸标注框架类型时 undefined
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

- [jsDocMetadata.ts](./jsDocMetadata.md) - JSDoc 工具函数（hasExportModifier / getJSDocFromNode / extractDescription / @tag 标签值提取——现用于 @tool 残留标签检测，统一来源）

- [scanTools](../tools/scanTools.md) - 产出 `ToolManifest`(含 `functionName`),供本模块的 `pathMeta` 来源
- [toolTypes](../tools/toolTypes.md) - `ToolManifest` 类型定义
- [createProgram](./createProgram.md) - 创建 TypeScript Program
- [extractHandlerTypes](./extractHandlerTypes.md) - 下游消费 `inputTypeName` 提取完整类型结构
- [generateToolArtifacts](../cli/generateToolArtifacts.md) - 下游消费 `ToolMetadata[]` 生成 `faapi-tools.js` + `zod.js`
- [toolRegistry](../injection/toolRegistry.md) - `getTool` 返回 `ToolMetadata`(含 `ToolCore` 字段),供 agent 运行时按名查找
- [agentTypes](../agents/agentTypes.md) - agent 元数据类型定义(对称设计参考,同样有 `AgentCore`/`AgentMetadata` 分层)
- [analyzeInjection](../injection/analyzeInjection.md) - 路由 handler 参数提取(对称设计参考)
