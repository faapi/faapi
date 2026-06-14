# resolveInput

一句话概括：根据 HTTP 方法和 Content-Type 解析请求输入。

## 为什么需要

GET/DELETE 从 URL 提取 query，POST/PUT/PATCH 从请求体提取数据，需要统一接口。
不同 Content-Type（JSON / multipart / form-urlencoded）解析方式不同，且空 body
与非法 JSON 需要区分对待（前者视为无 body，后者抛 ValidationError）。

## 使用场景

- 请求处理时解析输入
- 根据 method 选择输入来源（query 或 body）
- 根据 Content-Type 选择 body 解析方式

## 行为约定

| Content-Type                       | 行为                                       |
| ---------------------------------- | ------------------------------------------ |
| `multipart/form-data`              | 调用 `parseMultipart`，返回 `{ fields, files }` |
| `application/x-www-form-urlencoded`| 按 `URLSearchParams` 解析为字符串字段对象    |
| 其它（默认 JSON）                   | 调用 `parseJsonBody` 解析                    |

- 空请求体（含纯空白）：返回 `null`（handler 可不声明 body 参数）
- 非空请求体且 JSON 解析失败：抛 `ValidationError(code=INVALID_FORMAT)`，
  不再静默返回 `null` 导致后续报"字段缺失"

## 相关模块

- `queryToObject.ts` - 提取 query
- `parseJsonBody.ts` - 解析 JSON（保持纯函数,不抛错）
- `parseMultipart.ts` - 解析 multipart
- `../errors/httpErrors.ts` - `ValidationError` 定义
