# buildCommand

一句话概括：CLI 构建命令，预编译 schema 模块 + 路由清单，并编译 TypeScript。

## 为什么需要

生产环境需要预编译注入元数据与路由清单，避免运行时 AST 分析与文件扫描开销。
start 命令直接读取 build 产物，无需 tsx，不扫描文件系统。

## 使用场景

- `faapi build` 命令
- 生成 `dist/faapi-schema.js`（schema 校验模块）
- 生成 `dist/faapi-routes.js`（序列化路由清单）
- 生成 `faapi-types.ts`（RPC 类型文件，可选）
- 编译 TypeScript 到 dist/

## 构建步骤

1. 扫描路由（`scanRoutes`，dev 形式 `.ts`）
2. 生成类型文件（`generateTypes`）
3. 生成 schema 模块（`writeSchemaModule` → `dist/faapi-schema.js`）
4. 生成路由清单（`serializeRoutes` + `writeRoutesModule` → `dist/faapi-routes.js`）
5. 编译 TypeScript（esbuild 逐文件编译，保持目录结构）

## 相关模块

- `generateSchema.ts` - 生成 schema 校验模块
- `generateRoutes.ts` - 序列化路由清单与水合还原
- `scanRoutes.ts` - 扫描路由
