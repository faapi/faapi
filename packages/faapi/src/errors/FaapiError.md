# FaapiError

一句话概括：框架基础错误类。

## 为什么需要

所有框架错误继承此类，统一错误结构（code、message、statusCode），便于错误处理。

## 使用场景

- 抛出框架错误
- 错误类型判断

## 相关模块

- `errorCodes.ts` - 错误码定义
- `httpErrors.ts` - 具体错误类
