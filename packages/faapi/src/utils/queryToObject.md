# queryToObject

一句话概括：将 URLSearchParams 转换为普通对象。

## 为什么需要

URLSearchParams 是迭代器，不便于类型校验和属性访问。转换为普通对象后，可以进行参数校验。

## 使用场景

- GET 请求参数提取
- 转换查询参数为可校验对象

## 相关模块

- `resolveInput.ts` - 提取 GET/DELETE 参数
