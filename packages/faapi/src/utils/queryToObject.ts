/**
 * URLSearchParams → query 对象
 *
 * 重复 key 聚合为数组（对齐 Express qs / Hono getAll 语义）：
 * - `?page=1` → `{ page: '1' }`
 * - `?tag=a&tag=b` → `{ tag: ['a', 'b'] }`
 *
 * 此前 last-wins 静默丢弃前面的值（`?ids=1&ids=2` 得 `'2'`），且 query schema
 * 的 coerce 管线对 array 元素同样生成 preprocess——声明 `ids: number[]` 的字段
 * 此前永远校验失败（解析端从未产出数组），属于校验管线输入端漏洞。
 */
export function queryToObject(params: URLSearchParams): Record<string, unknown> {
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
  return result;
}
