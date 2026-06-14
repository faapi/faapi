# buildCommand

一句话概括：CLI 构建命令，预编译元数据并编译 TypeScript。

## 为什么需要

生产环境需要预编译注入元数据，避免运行时 AST 分析开销。

## 使用场景

- `faapi build` 命令
- 生成 `.faapi/meta.json`
- 编译 TypeScript 到 dist/

## 相关模块

- `generateSchema.ts` - 生成 schema 校验模块
- `scanRoutes.ts` - 扫描路由
