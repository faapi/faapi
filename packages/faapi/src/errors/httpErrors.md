# httpErrors

一句话概括：HTTP 相关的具体错误类，含结构化校验问题（ValidationIssue），状态码按错误语义细分。

## 为什么需要

为常见 HTTP 错误（400/404/405/422/500）提供具体错误类，包含详细信息。
`ValidationIssue` 提供结构化错误信息，便于上层（全局错误中间件 / 前端）按 code 做不同处理。
状态码按错误语义细分（参考 RFC 7807 / Rails / Laravel / Spring），让前端可基于状态码区分错误类型。

## 使用场景

- 抛出 400 请求语法错误（含 `ValidationIssue[]`，code 为 `INVALID_FORMAT`/`MISSING_FIELD`）
- 抛出 422 语义错误（含 `ValidationIssue[]`，code 为 `TYPE_MISMATCH`/`INVALID_VALUE`/`COERCE_FAILED`）
- 抛出 404 路由不存在
- 抛出 405 方法不允许
- 抛出 500 内部错误

## 状态码映射

`ValidationError` 根据 issues 中的 code 自动推导状态码（多个 issue 时取最高严重度，400 优先）：

| code | 状态码 | 语义 |
|------|--------|------|
| `INVALID_FORMAT` | 400 Bad Request | 请求语法错误（JSON 解析失败、Date 非 ISO 8601） |
| `MISSING_FIELD` | 400 Bad Request | 请求不完整（缺必填字段） |
| `TYPE_MISMATCH` | 422 Unprocessable Entity | 语法正确但类型不匹配 |
| `INVALID_VALUE` | 422 Unprocessable Entity | 语法正确但值不在允许范围 |
| `COERCE_FAILED` | 422 Unprocessable Entity | 语法正确但 query 字符串转换失败 |

`422 Unprocessable Entity` 语义：服务器理解请求格式（JSON 合法），但无法处理其中的语义内容。

## null 处理契约

| 类型声明 | 传 `null` 的行为 |
|---------|-------------------|
| `name: string` | 报 `TYPE_MISMATCH`（422） |
| `name?: string` | 报 `TYPE_MISMATCH`（422） |
| `name: string \| null` | 通过 |
| `name?: string \| null` | 通过 |

**必须显式声明 `null`（或 `string | null`）才能传 `null`**，可选（`?`）只允许字段缺失（`undefined`），不允许传 `null`。

## ValidationIssue 结构

| 字段 | 说明 | 示例 |
|------|------|------|
| `path` | 字段路径 | `'user.address.city'` |
| `code` | 错误码（机器可读契约） | `'TYPE_MISMATCH'` |
| `expected` | 期望类型/值 | `'number'` / `"'admin' \| 'user'"` |
| `received` | 实际类型/值 | `'string'` / `'undefined'` |
| `message` | 人类可读消息（兜底,不保证稳定） | `'期望 number，实际 string'` |

### ValidationErrorCode

| code | 含义 | 触发场景 |
|------|------|----------|
| `TYPE_MISMATCH` | 类型不匹配 | string 期望 number |
| `MISSING_FIELD` | 缺少必填字段 | 必填字段未传 |
| `INVALID_FORMAT` | 格式错误 | JSON 解析失败、Date 非 ISO 8601 |
| `INVALID_VALUE` | 值不在允许范围 | 字面量/enum 不匹配 |
| `COERCE_FAILED` | 类型转换失败 | query 字符串转 number/boolean 失败 |

## 相关模块

- `FaapiError.ts` - 基础错误类
- `formatErrorResponse.ts` - 格式化响应
- `../validator/validateInput.ts` - 校验输入,将 zod issue 映射为 `ValidationIssue`（coerce 已内联到 zod schema,详见 `../validator/README.md`）
