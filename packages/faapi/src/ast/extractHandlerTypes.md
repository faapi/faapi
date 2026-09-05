# extractHandlerTypes

一句话概括：从源文件提取 interface / type alias 的类型信息（属性名、类型、可选性）。

## 为什么需要

从 TypeScript interface 提取属性名、类型、可选性，作为 RuntimeType 描述，供后续生成 zod schema。

## 使用场景

- `extractTypeInfo`：提取指定名称的类型（如 GETQuery、POSTBody），用于生成单个 zod schema
- `extractAllTypes`：提取文件内所有命名类型（保留为独立 AST 能力；schema 生成主链路已改用 `createLazyTypeResolver` 惰性解析）
- `createLazyTypeResolver`：按名称惰性解析 + 缓存（`resolve(name)` 幂等返回同一实例，未声明返回 null）。与 `extractAllTypes` 的差异：无关类型零开销——文件中未被引用的类型含不支持语法不再拖垮整个提取

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
