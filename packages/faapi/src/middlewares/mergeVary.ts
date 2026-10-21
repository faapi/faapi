import type { ResponseMeta } from '../runtime/contextTypes';

/**
 * 向响应 meta.headers 大小写不敏感地合并 Vary 值
 *
 * 延迟落头（headers-only meta）通道是响应头的唯一权威来源——读请求头
 * （ctx.headers.get('vary')）既看不到其他中间件已设置的响应 Vary，还会把客户端
 * 伪造的 Vary 请求头带进响应。CORS（Vary: Origin）与 compression
 * （Vary: Accept-Encoding）共用此函数，互不覆盖。
 */

/** 向 meta.headers 合并 Vary 值（CORS 等中间件可能已设置 Vary，不能覆盖） */
export function mergeVary(meta: ResponseMeta, value: string): void {
  const existing = meta.headers['Vary'] ?? meta.headers['vary'];
  if (!existing) {
    meta.headers['Vary'] = value;
    return;
  }
  // 大小写不敏感地检查是否已包含（按逗号分段精确匹配，避免 'X-Origin' 误判含 'Origin'）
  const segments = existing.split(',').map((s) => s.trim().toLowerCase());
  if (!segments.includes(value.toLowerCase())) {
    const key = meta.headers['Vary'] !== undefined ? 'Vary' : 'vary';
    meta.headers[key] = `${existing}, ${value}`;
  }
}
