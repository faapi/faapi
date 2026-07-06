# parseJsonBody

一句话概括：安全解析 JSON 字符串，返回结果对象（不抛异常）。

## 为什么需要

请求体解析时，JSON 可能格式错误。使用结果对象而非异常，便于调用方决定如何处理。
`resolveInput.ts` 消费此结果,在 JSON 解析失败时抛 `ValidationError(INVALID_FORMAT)`。

## 使用场景

- 解析请求体（由 `resolveInput.ts` 调用）
- 任何需要安全 JSON 解析的场景

## 行为

- 合法 JSON：返回 `{ success: true, data }`
- 非法 JSON：返回 `{ success: false, error: 'Invalid JSON body' }`
- 保持纯函数语义,不抛异常,不调用错误处理逻辑

## 相关模块

- `resolveInput.ts` - HTTP 请求输入解析,JSON 失败时抛 ValidationError
- `../errors/httpErrors.ts` - ValidationError 定义
