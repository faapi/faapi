# 错误体系

统一错误类型和响应格式，确保所有错误以一致的 JSON 结构返回。

## 模块

| 模块 | 说明 |
| --- | --- |
| [FaapiError.ts](./FaapiError.ts) | 基类：code + message + statusCode |
| [httpErrors.ts](./httpErrors.ts) | HTTP 错误子类 |
| [errorCodes.ts](./errorCodes.ts) | 错误码常量 |
| [formatErrorResponse.ts](./formatErrorResponse.ts) | 将错误统一转为 JSON Response |

## 错误类型

| 错误类 | 状态码 | 错误码 | 说明 |
| --- | --- | --- | --- |
| `ValidationError` | 400 | `VALIDATION_ERROR` | query/body/params 缺失或非法，附带 issues 详情 |
| `RouteNotFoundError` | 404 | `ROUTE_NOT_FOUND` | 路由不存在 |
| `MethodNotAllowedError` | 405 | `METHOD_NOT_ALLOWED` | 方法不允许，附带 Allow 头 |
| `InternalError` | 500 | `INTERNAL_ERROR` | 内部错误 |
| `ModuleLoadError` | 500 | `MODULE_LOAD_ERROR` | 模块加载失败 |

## 响应格式

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "参数校验失败",
    "issues": [{ "path": "page", "message": "缺少必填字段 \"page\"" }]
  }
}
```

ValidationError 额外包含 `issues` 字段；MethodNotAllowedError 的响应头包含 `Allow`。

## 相关模块

- [validator](../validator/README.md)：触发 ValidationError
- [server](../server/README.md)：调用 formatErrorResponse
