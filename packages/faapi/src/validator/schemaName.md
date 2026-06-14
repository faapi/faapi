# schemaName

一句话概括：生成 schema 类型名。

## 为什么需要

根据 HTTP 方法和输入类型生成类型名（如 GETQuery、POSTBody），用于查找 interface 定义。

## 使用场景

- 生成类型命名约定
- 查找对应的 interface

## 相关模块

- `getSchemaForHandler.ts` - 调用此函数
