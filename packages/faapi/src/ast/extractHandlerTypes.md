# extractHandlerTypes

一句话概括：从源文件提取 interface / type alias 的类型信息（属性名、类型、可选性）。

## 为什么需要

从 TypeScript interface 提取属性名、类型、可选性，作为 RuntimeType 描述，供后续生成 zod schema。

## 使用场景

- `extractTypeInfo`：提取指定名称的类型（如 GETQuery、POSTBody），用于生成单个 zod schema
- `extractCtxTypeInfo`：tool ctx 校验类型的剥离解析（见下节）
- `extractInlineParamTypeInfo`：HTTP 路由形参内联标注（`query: { page: number }`）的直接解析（见下节）
- `extractAllTypes`：提取文件内所有命名类型（保留为独立 AST 能力；schema 生成主链路已改用 `createLazyTypeResolver` 惰性解析）
- `createLazyTypeResolver`：按名称惰性解析 + 缓存（`resolve(name)` 幂等返回同一实例，未声明返回 null）。与 `extractAllTypes` 的差异：无关类型零开销——文件中未被引用的类型含不支持语法不会拖垮整个提取

## extractCtxTypeInfo（tool ctx 剥离解析）

tool ctx 校验类型的专用解析入口，语义见 [extractToolMetadata](./extractToolMetadata.md) 的「第二个参数的 ctx 校验类型名」。三段式：

1. **剥离解析**：按 `typeName` 定位到 type alias 声明且声明体为含框架侧成员的交叉（默认名形态：别名含 `AgentToolContext`，如 `type Combined = A & B & AgentToolContext`）→ 跳过框架侧成员，逐成员经 resolveTypeNode 解析（TypeReference 与内联字面量均可）按交叉合并语义（mergeObjectMember）合并为单 object——非 object 成员 / 同名字段冲突显式抛错
2. **内联回退**：同名声明搜不到且传入 `functionName`、handler 第二参标注为内联形态（`{ userId: number }`、`A & B & AgentToolContext` 等无法唯一具名的标注）→ 直接从第二参标注解析（剥离框架侧 + 合并）——纯内联标注的默认名 `${函数名}Ctx` 由此生成 schema
3. **原路径**：其余情况（普通业务类型名、无框架侧成员的别名、interface）回退 `extractTypeInfo`，行为不变

内联回退前声明查找与 extractTypeInfo 同构（本文件优先 → 跨文件回退跳过 node_modules / TypeScript lib，首个匹配生效）；合成名在提取侧已保证不与文件内声明同名（同名构建期抛错），因此内联回退不会被同名声明劫持。

interface extends AgentToolContext 不剥离（业务校验类型携带框架字段以交叉标注为唯一形态，extends 走原路径在框架字段 `import('...')` 语法上显式抛错）。

## extractInlineParamTypeInfo（HTTP 形参内联标注解析）

HTTP 路由 handler 的 input 形参支持内联类型字面量标注（`query: { page: number }`），与具名引用（`query: Query`）同为「声明即校验」。本函数按函数名 + 形参名定位标注节点：

- 标注为 TypeLiteral → `resolveTypeNode` 整体解析，包装为 `HandlerTypeInfo`（`name` 由调用方传入合成 schema 名，如 `GETQuery`——schema 导出名本就不依赖标注具名）
- 其余形态（TypeReference / 交叉 / 联合 / 关键词）→ `null`，由调用方按无 schema 处理（具名引用走 `resolver.resolve`，不在本函数职责内）
- 函数 / 形参不存在 → `null`

**合成名冲突 fail-fast**：合成 schema 名（如 `GETQuery`）与文件内已有顶层类型声明同名时抛 `SchemaExtractionError`——同名意味着校验源歧义（形参内联 vs 同名声明），且 zod.js 会出现双重声明；要求改用具名标注或重命名声明。与 tool ctx 的 `synthesizeCtxName` 同款语义。

## 跨文件类型解析回退

入口类型的首次引用由 checker 在 AST 提取阶段内联为完整 RuntimeType；同一入口类型中
第二次出现的引用会被标记为 `ref`（防循环引用无限递归），代码生成阶段通过
`createLazyTypeResolver.resolve(name)` 解析。该解析默认只扫 handler 自身文件的顶层声明，
跨文件类型（`import type { User } from './user'`）不在其中——若不回退，`ref` 解析失败
会静默生成 `z.unknown()`，校验弱于 TS 类型且无告警。

因此 `extractTypeInfo` 在自身文件找不到目标声明时，回退到 program 的其他源文件查找同名
顶层 interface / type alias / enum（跳过 node_modules 与 TypeScript lib，与
`resolveImportAlias` 兜底路径的过滤规则和"首个匹配生效"语义一致），用 fresh visited
解析为完整 RuntimeType。同名类型声明分布在多个文件时按首个匹配解析——与既有兜底路径
行为一致；命名冲突场景建议调用方避免。

## 相关模块

- `createProgram.ts` - 提供 Program(读项目 tsconfig 加载全部相关源文件,保证跨文件 import 的源文件在 program 中)
- `resolveTypeNode.ts` - 解析类型节点为 RuntimeType;`extractTypeInfo` / `extractAllTypes` 在分析前调 `setProgramContext(program)`、分析后调 `setProgramContext(null)`,供 `resolveImportAlias` 兜底遍历跨文件声明使用
- `generateZodSchema.ts` - 消费 HandlerTypeInfo 生成 zod schema 代码
- `../cli/collectRouteSchemaSources.ts` - 调用 createLazyTypeResolver（入口类型）+ extractTypeInfo 收集 schema 源数据
