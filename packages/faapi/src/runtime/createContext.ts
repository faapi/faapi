import type { FaapiContext, ResponseMeta, CookieOptions, FailOptions } from './contextTypes';
import { createSseWriter, type SseWriter } from './sse';
import type { ResponseConfig } from '../config/configTypes';

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
 * @param ip 客户端 IP（由调用方从 IncomingMessage 提取，HTTP/WS 握手均通过 utils/getClientIp）
 *
 * ua 不作为参数传入：User-Agent 是标准 HTTP 请求头，createContext 内部直接从
 * request.headers 读取（与 ip 不同，ip 需要从 IncomingMessage 提取故由调用方传入）。
 */
export function createContext(
  request: Request,
  params: Record<string, string>,
  config: Record<string, unknown> = {},
  ip: string = '',
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
    ip,
    ua: request.headers.get('user-agent') ?? '',
    cookies: cookiesObj,
    config,
    meta,

    setStatus(status: number) {
      meta.status = status;
    },

    setHeader(key: string, value: string) {
      meta.headers[key] = value;
    },

    setETag(value: string) {
      meta.headers['etag'] = value;
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

    /**
     * 显式包装成功响应(返回 Response,不会被自动包裹再次包装)
     *
     * 用 config.response.ok(或默认 (data) => ({ data })) 包裹 data 并返回 JSON Response。
     * handler 也可直接 return data,框架会自动用 ok 包裹,两者等价。
     */
    ok(data: unknown): Response {
      const responseConfig = (config as { response?: ResponseConfig }).response;
      const okFn = responseConfig?.ok ?? ((d: unknown) => ({ data: d }));
      const body = okFn(data);
      return ctx.json(body);
    },

    /**
     * 返回错误响应(对象形式参数,status 和 code 均可省略)
     *
     * - status 省略时 HTTP 状态码默认 500
     * - code 省略时响应 body 里不含 code 字段(默认 fail 函数只放非 undefined 的字段)
     * - status 和 code 独立无关联
     *
     * body 用 config.response.fail(或默认实现)包装。
     */
    fail(options: FailOptions): Response {
      const responseConfig = (config as { response?: ResponseConfig }).response;
      const failFn =
        responseConfig?.fail ??
        ((e: { status?: number; code?: string; message: string }) => {
          const error: Record<string, unknown> = { message: e.message };
          if (e.code !== undefined) error.code = e.code;
          return { error };
        });
      const body = failFn({
        status: options.status,
        code: options.code,
        message: options.message,
      });
      return ctx.json(body, options.status ?? 500);
    },
  } as FaapiContext & { meta: ResponseMeta; __sseResponse?: Response; __sseWriter?: SseWriter };

  // 执行用户自定义的 ctx 扩展钩子（config.extendContext）
  const extend = config?.extendContext;
  if (typeof extend === 'function') {
    extend(ctx);
  }

  return ctx;
}

/**
 * 测试专用：从选项对象创建 FaapiContext，免去手写 `new Request(url)` 的样板代码
 *
 * 与 createContext 的关系：createTestContext 内部构造 Request 后调 createContext，
 * 语义完全一致，仅是测试场景的语法糖——不写无意义的 host、query 用对象形式、headers 直接传对象。
 *
 * 为什么不合并进 createContext：createContext 运行时也从真实 HTTP 请求构造 Request，
 * 保持 `(request: Request)` 签名使运行时与测试同构；createTestContext 是纯测试便捷封装，
 * 不引入运行时分支。
 *
 * body 不在此处理：createContext 本身不读 `request.body`，body 注入由 `invokeHandler`
 * 的第 3 个参数负责。POST/PUT/PATCH 测试时 body 单独传给 invokeHandler，避免在两处传 body 产生混淆。
 *
 * @param options 请求选项（path 必填，其余可选）
 * @returns FaapiContext
 */
export function createTestContext(options: CreateTestContextOptions): FaapiContext {
  const { method = 'GET', path, query, headers, params = {}, config = {}, ip = '' } = options;

  // 用 URL 解析 + 拼 query，避免手动拼接字符串的转义问题
  const url = new URL(`http://localhost${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const request = new Request(url.toString(), {
    method,
    headers: headers as HeadersInit | undefined,
  });

  return createContext(request, params, config, ip);
}

/**
 * createTestContext 的选项
 */
export interface CreateTestContextOptions {
  /** 请求方法，默认 'GET' */
  method?: string;
  /** 请求路径，必填，如 '/api/user'（无需写 host） */
  path: string;
  /** 查询参数，对象形式，自动拼接到 URL（值会被 String() 转换；数组生成同名多值参数） */
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  /** 请求头 */
  headers?: Record<string, string>;
  /** 动态路由参数，默认 {} */
  params?: Record<string, string>;
  /** 业务配置（来自 faapi.config.ts），默认 {} */
  config?: Record<string, unknown>;
  /** 客户端 IP，默认 '' */
  ip?: string;
}
