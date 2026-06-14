# analyzeInjection

一句话概括：AST 分析 handler 函数，提取参数注入元数据。

## 为什么需要

运行时无法获取 TypeScript 类型的完整结构。通过 AST 分析，可以在开发时提取参数名、类型、校验规则，生成元数据供运行时使用。

## 使用场景

- 开发启动时分析所有路由 handler
- 提取参数注入信息
- 提取类型校验规则

## 相关模块

- `resolveInjection.ts` - 运行时参数分析
- `extractHandlerTypes.ts` - 类型提取
