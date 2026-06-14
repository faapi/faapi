# createProgram

一句话概括：创建 TypeScript Program 用于 AST 分析。

## 为什么需要

参数校验需要分析 TypeScript interface 定义，需要创建 TS Program 来访问 AST。

## 使用场景

- 参数校验前创建 Program
- 为 AST 分析提供基础

## 相关模块

- `extractHandlerTypes.ts` - 使用 Program
- `validateInput.ts` - 调用此函数
