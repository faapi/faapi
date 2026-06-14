# extractHandlerTypes

一句话概括：从源文件提取 interface 类型信息。

## 为什么需要

从 TypeScript interface 提取属性名、类型、可选性，用于生成运行时校验器。

## 使用场景

- 提取 GETQuery、POSTBody 等类型
- 为校验器提供类型信息

## 相关模块

- `createProgram.ts` - 提供 Program
- `resolveTypeNode.ts` - 解析类型节点
- `generateValidatorCode.ts` - 使用类型信息生成校验函数
