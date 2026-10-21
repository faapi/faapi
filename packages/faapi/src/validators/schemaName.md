# schemaName

一句话概括：生成 schema 类型名。

## 为什么需要

根据 HTTP 方法和输入类型生成类型名（如 GETQuery、POSTBody）,用于查找 interface 定义。

## 使用场景

- 生成类型命名约定（`{METHOD}{InputType}` → `GETQuery` / `POSTBody` / `PATCHParams`）
- 查找对应的 interface

## 相关模块

- `validateInput.ts` - 调用此函数定位 zod schema
- `../cli/collectRouteSchemaSources.ts` - 调用此函数收集路由 schema 源
