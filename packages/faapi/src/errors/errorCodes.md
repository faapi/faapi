# errorCodes

一句话概括：定义框架统一错误码常量。

## 为什么需要

框架需要为不同类型的错误提供稳定的错误码（如 `VALIDATION_ERROR`、`ROUTE_NOT_FOUND`），确保错误响应结构一致，便于上层处理和客户端解析。

## 使用场景

- `httpErrors.ts` - 各错误类使用错误码
- `formatErrorResponse.ts` - 格式化错误响应时使用错误码
- `createServer.ts` - 请求分发时根据错误码返回对应状态码

## 相关模块

- `FaapiError.ts` - 基础错误类持有错误码
- `httpErrors.ts` - 具体错误类使用错误码
- `formatErrorResponse.ts` - 格式化错误响应
