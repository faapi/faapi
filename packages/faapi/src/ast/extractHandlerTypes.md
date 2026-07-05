# extractHandlerTypes

一句话概括：从源文件提取 interface / type alias 的类型信息（属性名、类型、可选性）。

## 为什么需要

从 TypeScript interface 提取属性名、类型、可选性，作为 RuntimeType 描述，供后续生成 zod schema。

## 使用场景

- `extractTypeInfo`：提取指定名称的类型（如 GETQuery、POSTBody），用于生成单个 zod schema
- `extractAllTypes`：提取文件内所有命名类型，作为 `resolveType` 提供给 `generateZodSchema`，解析循环引用中的 `ref`

## 相关模块

- `createProgram.ts` - 提供 Program
- `resolveTypeNode.ts` - 解析类型节点为 RuntimeType
- `generateZodSchema.ts` - 消费 HandlerTypeInfo 生成 zod schema 代码
- `../cli/collectRouteSchemaSources.ts` - 调用 extractTypeInfo / extractAllTypes 收集 schema 源数据
