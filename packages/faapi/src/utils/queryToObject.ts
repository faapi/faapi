/**
 * URLSearchParams → query 对象
 *
 * 重复 key 聚合为数组（对齐 Express qs / Hono getAll 语义）：
 * - `?page=1` → `{ page: '1' }`
 * - `?tag=a&tag=b` → `{ tag: ['a', 'b'] }`
 *
 * 数组聚合让声明 `ids: number[]` 的字段有合法的解析输入——query schema
 * 的 coerce 管线对 array 元素同样生成 preprocess。
 */
/**
 * 同一 URLSearchParams 实例的解析结果缓存
 *
 * GET 请求每请求会解析两次 query（resolveInput 组装 ctx 输入 + injectParams 注入
 * `query` 参数）——ctx.query 是 createContext 创建的同一 URLSearchParams 实例，
 * WeakMap 按实例缓存后第二次解析直接命中。实例随请求被 GC，无跨请求泄漏。
 */
const queryCache = new WeakMap<URLSearchParams, Record<string, unknown>>();

export function queryToObject(params: URLSearchParams): Record<string, unknown> {
  const cached = queryCache.get(params);
  if (cached) return cached;
  const result: Record<string, unknown> = {};
  for (const [key, value] of params) {
    const existing = result[key];
    if (existing === undefined) {
      result[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[key] = [existing, value];
    }
  }
  queryCache.set(params, result);
  return result;
}
