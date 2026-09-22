# stringifyJson

一句话概括：BigInt 安全的 `JSON.stringify` 替代——BigInt（含嵌套）序列化为字符串，其余行为与原生 `JSON.stringify` 完全一致。

## 为什么需要

原生 `JSON.stringify` 遇到 BigInt 直接抛 `TypeError: Do not know how to serialize a BigInt`——handler 返回含 BigInt 的值（如 drizzle bigint 模式的雪花 ID、大整数金额）时，响应序列化在 `toResponse` 抛错 → 500 INTERNAL_ERROR，且 `ctx.ok`/`ctx.fail`/SSE/WS 各序列化出口行为一致地炸。JSON 规范没有 BigInt 类型，字符串是业界标准的无损表示（`BigInt(s)` 可逆，数值上限内的 `Number(s)` 也可逆），比抛错更有用。

不处理循环引用——那是结构错误，应保持抛错暴露问题，不该静默产出坏 JSON。

## 使用场景

- 框架内所有 JSON 序列化出口统一使用：`toResponse`（对象/数组/fallback 分支）、`jsonRaw`（`ctx.ok`/`ctx.fail`/`ctx.json`/错误兜底 `formatErrorResponse`）、SSE `send` 的对象 data、WS `send` 的对象数据
- 业务侧自定义 `response.ok` / `response.fail` 包装函数返回值仍经 `jsonRaw` 序列化，自动获得同样行为

## 相关模块

- `../response/toResponse.ts` - 成功路径序列化
- `../response/responseFormatter.ts` - 显式响应与错误兜底序列化
- `../runtime/sse.ts` / `../runtime/wsHandler.ts` - 消息帧序列化

## 序列化规则速查

| 值 | 输出 |
|----|------|
| `123n` / 嵌套 BigInt | `"123"`（字符串） |
| `Date` | ISO 8601 字符串（`toJSON` 先于 replacer 生效，行为不变） |
| `NaN` / `Infinity` | `null`（原生 JSON 规则，不变） |
| 循环引用 | 抛 `TypeError`（不变，显式失败） |
