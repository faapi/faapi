# errorCodes

一句话概括：定义框架统一错误码常量。

## 为什么需要

框架需要为不同类型的错误提供稳定的错误码（如 `VALIDATION_ERROR`、`ROUTE_NOT_FOUND`），确保错误响应结构一致，便于上层处理和客户端解析。

## 错误码常量清单

| 常量 | 值 | 对应错误类 | 状态码 |
| --- | --- | --- | --- |
| `VALIDATION_ERROR` | `'VALIDATION_ERROR'` | `ValidationError` | 400/422（按 issue.code 推导） |
| `ROUTE_NOT_FOUND` | `'ROUTE_NOT_FOUND'` | `RouteNotFoundError` | 404 |
| `METHOD_NOT_ALLOWED` | `'METHOD_NOT_ALLOWED'` | `MethodNotAllowedError` | 405 |
| `PAYLOAD_TOO_LARGE` | `'PAYLOAD_TOO_LARGE'` | `PayloadTooLargeError` | 413 |
| `INTERNAL_ERROR` | `'INTERNAL_ERROR'` | `InternalError` / 未知错误兜底 | 500 |
| `MODULE_LOAD_ERROR` | `'MODULE_LOAD_ERROR'` | `ModuleLoadError` | 500 |

`ErrorCode` 类型为上述常量值的联合类型，确保类型安全。

## 使用场景

- `httpErrors.ts` - 各错误类构造函数传入对应错误码
- `formatErrorResponse.ts`（re-export 自 `response/responseFormatter.ts`） - 未知错误兜底时使用 `INTERNAL_ERROR`
- `createServer.ts` - 请求分发时根据错误码返回对应状态码

## 相关模块

- `FaapiError.ts` - 基础错误类持有错误码
- `httpErrors.ts` - 具体错误类使用错误码
- `formatErrorResponse.ts` - 格式化错误响应（实现位于 `response/responseFormatter.ts`）
