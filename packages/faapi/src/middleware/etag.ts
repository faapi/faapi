import { createHash } from 'node:crypto';
import type { FaapiMiddleware } from './middlewareTypes';
import type { FaapiContext, ResponseMeta } from '../runtime/contextTypes';
import { consumePendingMetaHeaders } from '../response/pendingMeta';

export interface EtagOptions {
  /**
   * 生成弱 ETag（`W/"<hash>"`）。弱校验器允许压缩等表示差异下的 304 协商，
   * 与 compression 中间件配合正确；强 ETag 需对每个表示（编码）单独生成
   * @default true
   */
  weak?: boolean;
}

const DEFAULTS: Required<EtagOptions> = { weak: true };

/** 计算 ETag：SHA-1 指纹 base64；weak=true 生成弱校验器（W/ 前缀） */
function computeEtag(body: string, weak: boolean): string {
  const hash = createHash('sha1').update(body).digest('base64');
  return weak ? `W/"${hash}"` : `"${hash}"`;
}

/** If-None-Match 比对：weak 模式用 RFC 7232 弱比较（忽略 W/ 前缀）；strong 模式精确比对 */
function ifNoneMatchMatches(ifNoneMatch: string, etag: string, weak: boolean): boolean {
  const normalize = (tag: string) => tag.trim().replace(/^W\//i, '');
  if (weak) {
    const target = normalize(etag);
    return ifNoneMatch.split(',').some((tag) => {
      const trimmed = tag.trim();
      return trimmed === '*' || normalize(trimmed) === target;
    });
  }
  // 强比较：ETag 原样相等（含 W/ 前缀语义，弱 ETag 永不匹配强比较）
  return ifNoneMatch.split(',').some((tag) => tag.trim() === etag || tag.trim() === '*');
}

/**
 * 创建 ETag/304 协商中间件（内建，默认关闭，`config.etag` 显式启用）
 *
 * `await next()` 后对 GET/HEAD 2xx 响应计算弱 ETag 并写入 meta（handler 显式
 * `ctx.setETag()` 时不覆盖）；请求 `If-None-Match` 弱比较命中时返回 304（无 body）。
 *
 * 中间件位置在 compression 内层：先算 ETag/304 再压缩——304 无 body 压缩自动跳过；
 * 弱 ETag 基于未压缩表示计算，语义正确。
 */
export function etag(options: EtagOptions = {}): FaapiMiddleware {
  const opts = { ...DEFAULTS, ...options };

  return async (ctx, next) => {
    const meta = (ctx as FaapiContext & { meta: ResponseMeta }).meta;
    const response = await next();
    if (!response) return response;

    // 仅协商幂等方法的 2xx 响应
    const method = ctx.request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return response;
    if (response.status < 200 || response.status >= 300) return response;

    // handler 已显式设置 ETag（ctx.setETag 写 meta.headers.etag）→ 控制权归 handler
    if (meta.headers['etag'] !== undefined || response.headers.has('etag')) {
      return response;
    }
    // 流式响应（SSE 等）不缓冲
    if (
      response.body === null ||
      (response.headers.get('content-type') ?? '').includes('text/event-stream')
    ) {
      return response;
    }

    const bodyText = await response.text();
    const etagValue = computeEtag(bodyText, opts.weak);

    // If-None-Match 弱比较命中 → 304（无 body，携带 ETag）
    const ifNoneMatch = ctx.request.headers.get('if-none-match');
    if (ifNoneMatch && ifNoneMatchMatches(ifNoneMatch, etagValue, opts.weak)) {
      return new Response(null, {
        status: 304,
        statusText: response.statusText,
        headers: { ETag: etagValue },
      });
    }

    // 200 路径：body 已被 text() 消费，重建响应；ETag 经 meta 传递（mergeMeta 兜底应用）
    meta.headers['etag'] = etagValue;
    const headers = new Headers(response.headers);
    // 延迟落头并入重建的 Response（etag 中间件位于 compression 内层，先消费）
    const deferredHeaders = consumePendingMetaHeaders(response);
    for (const [key, value] of Object.entries(deferredHeaders ?? {})) {
      headers.set(key, value);
    }
    return new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
