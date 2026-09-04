# extractHandlerTypes

一句话概括：从源文件提取 interface / type alias 的类型信息（属性名、类型、可选性）。

## 为什么需要

从 TypeScript interface 提取属性名、类型、可选性，作为 RuntimeType 描述，供后续生成 zod schema。

## 使用场景

- `extractTypeInfo`：提取指定名称的类型（如 GETQuery、POSTBody），用于生成单个 zod schema
- `extractAllTypes`：提取文件内所有命名类型（保留为独立 AST 能力；schema 生成主链路已改用 `createLazyTypeResolver` 惰性解析）
- `createLazyTypeResolver`：按名称惰性解析 + 缓存（`resolve(name)` 幂等返回同一实例，未声明返回 null）。与 `extractAllTypes` 的差异：无关类型零开销——文件中未被引用的类型含不支持语法不再拖垮整个提取

## 相关模块

- `createProgram.ts` - 提供 Program(读项目 tsconfig 加载全部相关源文件,保证跨文件 import 的源文件在 program 中)
- `resolveTypeNode.ts` - 解析类型节点为 RuntimeType;`extractTypeInfo` / `extractAllTypes` 在分析前调 `setProgramContext(program)`、分析后调 `setProgramContext(null)`,供 `resolveImportAlias` 兜底遍历跨文件声明使用
- `generateZodSchema.ts` - 消费 HandlerTypeInfo 生成 zod schema 代码
- `../cli/collectRouteSchemaSources.ts` - 调用 createLazyTypeResolver（入口类型）+ extractTypeInfo 收集 schema 源数据
