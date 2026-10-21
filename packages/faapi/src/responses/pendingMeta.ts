import type { ResponseMeta } from '../runtime/contextTypes';

/**
 * 仅 headers 型 meta 的延迟落头通道
 *
 * Web Response 一旦构造不可变——此前 `ctx.ok()` / `ctx.fail()` 等返回 Response
 * 的场景，即使 meta 只有 headers（helmet 开启后每请求 ~13 个静态头），也要
 * `new Headers()` 拷贝 + `new Response()` 重建一次。改为把 headers 记入
 * WeakMap（按响应对象弱键，响应被 GC 自动清理），由 Node 发送层
 * （sendNodeResponse）最后一次性 `setHeader`——热路径零重建。
 *
 * 中间件若重建 Response（如 compression / etag 的大 body 分支），需用
 * `consumePendingMetaHeaders` 把延迟头并入新 Response 的 headers，避免丢失。
 */

const pending = new WeakMap<Response, Record<string, string>>();

/**
 * 记录延迟落头（headers-only meta 场景）
 *
 * 同一响应多次记录按 key 合并（后写覆盖，与 mergeMeta 的 headers.set 语义一致）。
 */
export function deferMetaHeaders(response: Response, headers: Record<string, string>): void {
  const existing = pending.get(response);
  if (existing) {
    Object.assign(existing, headers);
    return;
  }
  pending.set(response, { ...headers });
}

/**
 * 取出并清除响应的延迟头（发送层 / 重建方消费）
 */
export function consumePendingMetaHeaders(response: Response): Record<string, string> | undefined {
  const headers = pending.get(response);
  if (headers) pending.delete(response);
  return headers;
}

/** meta 是否仅含 headers（无 status / setCookies，可走延迟通道） */
export function isHeadersOnlyMeta(meta: ResponseMeta): boolean {
  return meta.status === undefined && meta.setCookies.length === 0;
}
