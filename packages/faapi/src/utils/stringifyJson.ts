/**
 * BigInt 安全的 JSON.stringify
 *
 * JSON 规范没有 BigInt 类型，原生 `JSON.stringify` 遇到 BigInt（含嵌套）直接抛
 * `TypeError: Do not know how to serialize a BigInt`——handler 返回含 BigInt 的值
 * （drizzle bigint 模式的主键、大整数金额等）会在响应序列化时炸成 500。
 *
 * 字符串是 JSON 生态对 BigInt 的标准无损表示（`BigInt(s)` 可逆），此函数将
 * BigInt（含嵌套字段、数组元素、自定义 toJSON 返回值）序列化为字符串，其余行为
 * 与原生 `JSON.stringify` 完全一致：Date 走 `toJSON` 输出 ISO 字符串、NaN/Infinity
 * 输出 null、循环引用仍抛 TypeError（结构错误应显式失败，不静默产出坏 JSON）。
 *
 * 框架内所有 JSON 序列化出口统一使用本函数：toResponse（成功路径）、jsonRaw
 * （ctx.ok/ctx.fail/ctx.json/错误兜底）、SSE send、WS send。语义详见 ./stringifyJson.md。
 */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    typeof val === 'bigint' ? val.toString() : val,
  );
}
