# formatErrorResponse

一句话概括：将错误转换为统一的 JSON 响应，作为框架内置兜底。

## 为什么需要

所有错误需要转换为统一的 JSON 格式响应，包含 code、message、issues 等字段。
当用户未配置 `errorFormat`、或 `errorFormat` 返回 null/undefined（未处理）、或 `errorFormat` 抛错时，
由本函数兜底生成响应。

## 使用场景

- 错误处理时格式化响应（兜底链最后一环）
- 统一错误响应结构

## 相关模块

- `httpErrors.ts` - 错误类
- `server/serverUtils.ts` - `buildErrorResponse` 调用此函数
- `config/configTypes.ts` - `ErrorFormatFn` 优先于此函数处理

