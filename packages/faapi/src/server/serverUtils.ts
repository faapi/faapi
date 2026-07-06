import type { IncomingMessage } from 'node:http';
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
 * 构建错误响应(兜底链)
 *
 * 1. 框架内置 formatErrorResponse 处理(handler 抛错时)
 * 2. 内置兜底仍抛错 → 最简 500 JSON 响应
 *
 * 业务方如需自定义错误响应,在全局中间件中 try/catch next() 即可。
 */
export function buildErrorResponse(err: unknown): Response {
  try {
    return formatErrorResponse(err);
  } catch {
    // 极端情况:内置兜底也失败,返回最简 500
    return new Response(
      JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
}
