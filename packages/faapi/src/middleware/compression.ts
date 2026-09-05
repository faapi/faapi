import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { FaapiMiddleware } from './middlewareTypes';
import type { FaapiContext, ResponseMeta } from '../runtime/contextTypes';

const gzipAsync = promisify(zlib.gzip);
const deflateAsync = promisify(zlib.deflate);
const brotliAsync = promisify(zlib.brotliCompress);

export interface CompressionOptions {
  /**
   * 最小压缩字节数，body 低于该值不压缩（小 payload 压缩后反而变大）
   * @default 1024
   */
  threshold?: number;
}

const DEFAULT_THRESHOLD = 1024;

/** 可压缩的 Content-Type（text/event-stream 除外——流式语义不应缓冲） */
const COMPRESSIBLE_CHECKS: Array<(contentType: string) => boolean> = [
  (ct) => ct === 'application/json',
  (ct) => ct === 'application/javascript',
  (ct) => ct === 'image/svg+xml',
  (ct) => ct.startsWith('text/') && ct !== 'text/event-stream',
];

function isCompressible(contentType: string): boolean {
  const ct = contentType.split(';')[0]!.trim().toLowerCase();
  if (ct === '') return false;
  return COMPRESSIBLE_CHECKS.some((check) => check(ct));
}

interface AcceptedEncoding {
  encoding: string;
  quality: number;
}

/**
 * 解析 Accept-Encoding 头（含 q 值）
 *
 * `gzip, br;q=0.8, identity;q=0, *;q=0.5` → [{gzip,1},{br,0.8},{identity,0},{*,0.5}]
 */
export function parseAcceptEncoding(header: string): AcceptedEncoding[] {
  return header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const [encoding, ...params] = part.split(';');
      let quality = 1;
      for (const param of params) {
        const trimmed = param.trim();
        if (trimmed.startsWith('q=')) {
          const q = Number(trimmed.slice(2));
          if (Number.isFinite(q)) quality = q;
        }
      }
      return { encoding: (encoding ?? '').trim().toLowerCase(), quality };
    })
    .filter((e) => e.encoding !== '' && e.quality > 0);
}

/**
 * 从已接受的编码中选择压缩算法
 *
 * 服务器偏好 br > gzip > deflate（同等 q 值下）；`*` 通配按 gzip 处理。
 * 未命中返回 null（客户端不接受压缩）。
 */
export function selectEncoding(accepted: AcceptedEncoding[]): 'br' | 'gzip' | 'deflate' | null {
  const byName = new Map<string, number>();
  for (const { encoding, quality } of accepted) {
    // 同一编码出现多次取最高 q
    byName.set(encoding, Math.max(byName.get(encoding) ?? 0, quality));
  }
  // q=0 表示明确不接受
  for (const [encoding, quality] of byName) {
    if (quality === 0) byName.delete(encoding);
  }

  for (const candidate of ['br', 'gzip', 'deflate'] as const) {
    if ((byName.get(candidate) ?? 0) > 0) return candidate;
  }
  if ((byName.get('*') ?? 0) > 0) return 'gzip';
  return null;
}

async function compressBody(
  encoding: 'br' | 'gzip' | 'deflate',
  body: string,
): Promise<Uint8Array> {
  const buf = Buffer.from(body, 'utf-8');
  switch (encoding) {
    case 'br':
      return brotliAsync(buf);
    case 'gzip':
      return gzipAsync(buf);
    case 'deflate':
      return deflateAsync(buf);
  }
}

/** 向 meta.headers 合并 Vary 值（CORS 等中间件可能已设置 Vary: Origin，不能覆盖） */
function mergeVary(meta: ResponseMeta, value: string): void {
  const existing = meta.headers['Vary'] ?? meta.headers['vary'];
  if (!existing) {
    meta.headers['Vary'] = value;
    return;
  }
  // 大小写不敏感地检查是否已包含
  if (!existing.toLowerCase().includes(value.toLowerCase())) {
    const key = meta.headers['Vary'] !== undefined ? 'Vary' : 'vary';
    meta.headers[key] = `${existing}, ${value}`;
  }
}

/**
 * 创建响应压缩中间件（内建，默认关闭，`config.compression` 显式启用）
 *
 * 位于外层中间件链最前（包住 CORS/helmet/logger/全局），`await next()` 后拿到
 * 最终 Response：满足压缩条件（可压缩类型 + 大小达标 + 客户端接受）时缓冲 body
 * 异步压缩后构造新 Response 替换；否则透传。`Vary: Accept-Encoding` 通过
 * meta.headers 合并（与 CORS 的 Vary: Origin 共存），两种路径都生效。
 */
export function compression(options: CompressionOptions = {}): FaapiMiddleware {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  return async (ctx, next) => {
    const meta = (ctx as FaapiContext & { meta: ResponseMeta }).meta;
    const response = await next();
    if (!response) return response;

    // 无条件协商 Vary（响应内容随 Accept-Encoding 变化，与是否压缩本响应无关）
    mergeVary(meta, 'Accept-Encoding');

    // 跳过条件：客户端不接受 / 不可压缩类型 / 已编码 / no-transform / 204、304 等
    const acceptEncoding = ctx.request.headers.get('accept-encoding') ?? '';
    const encoding = selectEncoding(parseAcceptEncoding(acceptEncoding));
    const contentType = response.headers.get('content-type') ?? '';
    if (
      !encoding ||
      !isCompressible(contentType) ||
      response.headers.has('content-encoding') ||
      (response.headers.get('cache-control') ?? '').includes('no-transform') ||
      response.status === 204 ||
      response.status === 304 ||
      response.body === null
    ) {
      return response;
    }

    // 缓冲 body（toResponse 的 JSON body 本就是字符串）；SSE 已被 content-type 排除
    const bodyText = await response.text();
    if (bodyText.length < threshold) {
      // 未达阈值：body 已被 text() 消费，需重建等价 Response
      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const compressed = await compressBody(encoding, bodyText);
    const headers = new Headers(response.headers);
    headers.set('Content-Encoding', encoding);
    // Content-Length 由 Response 构造时按压缩后字节数自动设置（先删避免重复）
    headers.delete('Content-Length');
    return new Response(compressed as unknown as BodyInit, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
