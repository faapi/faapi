import type { IncomingMessage } from 'node:http';
import type { FaapiContext } from '../runtime/contextTypes';
import type { ErrorFormatFn } from '../config/configTypes';
import { formatErrorResponse } from '../errors/formatErrorResponse';

/**
 * 将 Node.js IncomingMessage 的 headers 转为 Web Headers
 *
 * 处理数组型 header 值（如 set-cookie）和 undefined 值。
 */
export function nodeHttpToWebHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

/**
 * 构建错误响应（兜底链）
 *
 * 1. 配置了 errorFormat → 优先调用；返回 Response 表示已处理
 * 2. errorFormat 返回 null/undefined（未处理）或抛错 → 框架内置 formatErrorResponse 兜底
 * 3. 内置兜底仍抛错 → 最简 500 JSON 响应
 */
export function buildErrorResponse(
  err: unknown,
  ctx: FaapiContext,
  errorFormat?: ErrorFormatFn,
): Response {
  if (errorFormat) {
    try {
      const res = errorFormat(err, ctx);
      if (res) return res;
    } catch {
      // errorFormat 抛错，落入下方 formatErrorResponse 兜底
    }
  }
  try {
    return formatErrorResponse(err);
  } catch {
    // 极端情况：内置兜底也失败，返回最简 500
    return new Response(
      JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
}
