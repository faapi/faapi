import type { FaapiContext, ResponseMeta, CookieOptions } from './contextTypes';
import { createSseWriter, type SseWriter } from './sse';

/**
 * 解析 Cookie 请求头为 Map
 */
function parseCookies(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.split('=');
    const trimmed = name?.trim();
    if (trimmed) {
      cookies.set(trimmed, rest.join('=').trim());
    }
  }
  return cookies;
}

/**
 * 格式化 Set-Cookie 值
 */
function formatSetCookie(name: string, value: string, options?: CookieOptions): string {
  let cookie = `${name}=${value}`;
  if (options?.domain) cookie += `; Domain=${options.domain}`;
  if (options?.path) cookie += `; Path=${options.path}`;
  if (options?.maxAge !== undefined) cookie += `; Max-Age=${options.maxAge}`;
  if (options?.expires) cookie += `; Expires=${options.expires.toUTCString()}`;
  if (options?.httpOnly) cookie += `; HttpOnly`;
  if (options?.secure) cookie += `; Secure`;
  if (options?.sameSite) cookie += `; SameSite=${options.sameSite}`;
  return cookie;
}

/**
 * 从 Request 对象创建 FaapiContext
 * @param request Web Request 对象
 * @param params 动态路由参数
 * @param config 自定义业务配置（来自 faapi.config.ts）
 */
export function createContext(
  request: Request,
  params: Record<string, string>,
  config: Record<string, unknown> = {},
): FaapiContext {
  const url = new URL(request.url);
  const meta: ResponseMeta = { headers: {}, setCookies: [] };
  const parsedCookies = parseCookies(request.headers.get('cookie') ?? '');
  const cookiesObj: Record<string, string> = {};
  for (const [key, val] of parsedCookies) {
    cookiesObj[key] = val;
  }

  const ctx = {
    request,
    params,
    query: url.searchParams,
    headers: request.headers,
    method: request.method,
    path: url.pathname,
    cookies: cookiesObj,
    config,
    meta,

    setStatus(status: number) {
      meta.status = status;
    },

    setHeader(key: string, value: string) {
      meta.headers[key] = value;
    },

    redirect(url: string, status = 302): Response {
      return new Response(null, {
        status,
        headers: { Location: url },
      });
    },

    json(data: unknown, status?: number): Response {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      return new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers,
      });
    },

    html(html: string, status?: number): Response {
      const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' };
      return new Response(html, {
        status: status ?? 200,
        headers,
      });
    },

    getCookie(name: string): string | undefined {
      return parsedCookies.get(name);
    },

    setCookie(name: string, value: string, options?: CookieOptions): void {
      meta.setCookies.push(formatSetCookie(name, value, options));
    },

    deleteCookie(name: string): void {
      meta.setCookies.push(formatSetCookie(name, '', { maxAge: 0 }));
    },

    /**
     * 创建 SSE writer，用于流式推送事件
     *
     * handler 调用此方法后，通过返回的 writer 推送事件，框架自动把 writer.response
     * 作为 HTTP 响应（Content-Type: text/event-stream）。
     *
     * 与 ctx.json / ctx.html 互斥：一个 handler 只能用一种响应方式。
     */
    sse(): SseWriter {
      const writer = createSseWriter();
      const ctxWithSse = ctx as FaapiContext & {
        __sseResponse?: Response;
        __sseWriter?: SseWriter;
      };
      ctxWithSse.__sseResponse = writer.response;
      ctxWithSse.__sseWriter = writer;
      return writer;
    },
  } as FaapiContext & { meta: ResponseMeta; __sseResponse?: Response; __sseWriter?: SseWriter };

  // 执行用户自定义的 ctx 扩展钩子（config.extendContext）
  const extend = config?.extendContext;
  if (typeof extend === 'function') {
    extend(ctx);
  }

  return ctx;
}
