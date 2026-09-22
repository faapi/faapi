---
'@faapi/faapi': minor
---

feat: JSON 序列化 BigInt 安全——所有响应出口 BigInt 统一转字符串，不再抛错 500

原生 `JSON.stringify` 遇到 BigInt 直接抛 `TypeError`，handler 返回含 BigInt 的值（drizzle bigint 模式主键、大整数金额等）时响应序列化失败 → 500 INTERNAL_ERROR。

框架新增 `utils/stringifyJson`（BigInt 安全的 `JSON.stringify` 替代）并统一接入全部 JSON 序列化出口：`toResponse`（handler 直接 return 数据）、`jsonRaw`（`ctx.ok`/`ctx.fail`/`ctx.json` 及错误兜底 `formatErrorResponse`）、SSE `send`、WS `send`。BigInt（含嵌套字段/数组元素/自定义 `toJSON` 返回值）序列化为字符串（JSON 无 BigInt 类型，字符串是标准无损表示，客户端 `BigInt(s)` 还原），其余行为与原生完全一致：Date 输出 ISO 8601 字符串、NaN/Infinity 输出 `null`、循环引用仍抛 `TypeError` 显式失败。
