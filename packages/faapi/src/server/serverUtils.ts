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
 * 1. 框架内置 formatErrorResponse 处理(handler 抛错时)——读 config.response.fail
 *    自定义包装函数,确保错误格式与 ctx.fail() 主动错误响应一致
 * 2. 内置兜底仍抛错 → 最简 500 JSON 响应
 *
 * 业务方如需进一步自定义错误响应,在全局中间件中 try/catch next() 即可。
 *
 * @param err handler 抛出的错误
 * @param config 业务方配置(用于读取 response.fail,可选——未传时走框架默认 fail 函数)
 */
export function buildErrorResponse(
  err: unknown,
  config?: Record<string, unknown> | undefined,
): Response {
  try {
    return formatErrorResponse(err, config);
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
