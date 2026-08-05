import type { SseWriter } from './sse';

/**
 * 请求上下文的响应元数据（内部使用，不暴露给用户）
 */
export interface ResponseMeta {
  status?: number;
  headers: Record<string, string>;
  setCookies: string[];
}

export interface CookieOptions {
  domain?: string;
  path?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * ctx.fail() 的参数类型(对象形式,status 和 code 均可省略)
 *
 * - status: HTTP 状态码(可选,省略时默认 500)
 * - code: 业务错误码(可选,省略时响应 body 里不含 code 字段)
 * - message: 人类可读错误描述(必填)
 *
 * status 和 code 是两个独立维度,无关联:
 * - status 控制 HTTP 状态码
 * - code 是 body 里的业务错误码字段
 *
 * ```ts
 * ctx.fail({ message: '出错' })                                  // HTTP 500, { error: { message: '出错' } }
 * ctx.fail({ status: 404, message: '用户不存在' })                // HTTP 404, { error: { message: '用户不存在' } }
 * ctx.fail({ status: 404, code: 'USER_NOT_FOUND', message: '用户不存在' }) // HTTP 404, { error: { code: 'USER_NOT_FOUND', message: '用户不存在' } }
 * ```
 */
export interface FailOptions {
  /** HTTP 状态码(可选,省略时默认 500) */
  status?: number;
  /** 业务错误码(可选,省略时响应 body 里不含 code 字段) */
  code?: string;
  /** 人类可读错误描述 */
  message: string;
}

/**
 * ctx.config 的类型：用户自定义业务配置
 *
 * 默认是 Record<string, unknown>（宽松）。用户可通过 `declare module '@faapi/faapi'` 增强：
 *
 * ```ts
 * declare module '@faapi/faapi' {
 *   interface FaapiContextConfig {
 *     db: { host: string; port: number };
 *   }
 * }
 * ```
 *
 * 增强后 `ctx.config.db.host` 即有类型提示。
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 保留 interface 以支持 declare module 声明合并增强 ctx.config 类型
export interface FaapiContextConfig extends Record<string, unknown> {}

export interface FaapiContext {
  request: Request;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Headers;
  method: string;
  path: string;
  /**
   * 客户端 IP
   *
   * 优先 `x-forwarded-for` 第一个 IP（反向代理场景），回退到 socket.remoteAddress。
   * IPv6 形式 `::ffff:1.2.3.4` 会被规整为 IPv4 形式 `1.2.3.4`。
   * 无法获取时为空字符串。
   */
  ip: string;
  /**
   * 客户端 User-Agent（请求头 `user-agent` 原值）
   *
   * 在 createContext 内部从 request.headers 读取（与 ip 不同，无需调用方传入）。
   * 不做解析/规整，仅原样透传；无该请求头时为空字符串。
   */
  ua: string;
  /** 解析后的所有 cookie 键值对 */
  cookies: Record<string, string>;
  /** 配置文件中的自定义业务配置（类型可通过 declare module '@faapi/faapi' 增强 FaapiContextConfig） */
  config: FaapiContextConfig;

  /**
   * 设置响应状态码
   */
  setStatus(status: number): void;

  /**
   * 设置响应头
   */
  setHeader(key: string, value: string): void;

  /**
   * 设置 ETag 响应头
   *
   * handler 中基于业务数据（如 updatedAt / version / contentHash）设置 ETag：
   * ```ts
   * export function GET(ctx) {
   *   const data = await fetchData();
   *   ctx.setETag(`"${data.version}-${data.updatedAt}"`);
   *   return data;
   * }
   * ```
   */
  setETag(value: string): void;

  /**
   * 返回 JSON 响应（handler 直接 return）
   *
   * ```ts
   * return ctx.json({ error: 'Not found' }, 404);
   * ```
   */
  json(data: unknown, status?: number): Response;

  /**
   * 返回 HTML 响应（handler 直接 return）
   *
   * ```ts
   * return ctx.html('<h1>Hello</h1>');
   * ```
   */
  html(html: string, status?: number): Response;

  /**
   * 返回重定向响应（handler 直接 return）
   *
   * ```ts
   * return ctx.redirect('/login');
   * ```
   */
  redirect(url: string, status?: number): Response;

  /**
   * 创建 SSE writer，用于流式推送事件（LLM token 流、进度通知等）
   *
   * handler 调用此方法后，通过返回的 writer 推送事件，框架自动把 writer.response
   * 作为 HTTP 响应（Content-Type: text/event-stream）。与 ctx.json / ctx.html 互斥。
   *
   * ```ts
   * export async function POST(ctx) {
   *   const sse = ctx.sse();
   *   for await (const chunk of stream) {
   *     sse.send({ data: chunk.text });
   *   }
   *   sse.close();
   * }
   * ```
   */
  sse(): SseWriter;

  /**
   * 显式包装成功响应(返回 Response 对象)
   *
   * 用 config.response.ok 包裹 data 并返回 Response。
   * 等价于 handler 直接 `return data`(框架自动包裹),但显式调用语义更清晰。
   *
   * 返回 Response 对象,不会被框架自动包裹再次包装(避免双重包裹)。
   *
   * ```ts
   * // 以下两种写法等价(假设配置了 response.ok = (data) => ({ data })):
   * export function GET() {
   *   return { id: 1 };              // 自动包裹 → { data: { id: 1 } }
   * }
   * export function GET2(ctx) {
   *   return ctx.ok({ id: 1 });      // 显式包裹 → { data: { id: 1 } }
   * }
   * ```
   */
  ok(data: unknown): Response;

  /**
   * 返回错误响应(对象形式参数,status 和 code 均可省略)
   *
   * @param options.status  HTTP 状态码(可选,省略时默认 500)
   * @param options.code    业务错误码(可选,省略时响应 body 里不含 code 字段)
   * @param options.message 人类可读错误描述(必填)
   *
   * status 和 code 独立无关联:status 控制 HTTP 状态码,code 是 body 里的业务错误码字段。
   *
   * ```ts
   * return ctx.fail({ message: '出错' });                                   // HTTP 500, { error: { message: '出错' } }
   * return ctx.fail({ status: 404, message: '用户不存在' });                 // HTTP 404, { error: { message: '用户不存在' } }
   * return ctx.fail({ status: 404, code: 'USER_NOT_FOUND', message: '用户不存在' }); // HTTP 404, { error: { code: 'USER_NOT_FOUND', message: '用户不存在' } }
   * ```
   */
  fail(options: FailOptions): Response;

  /**
   * 读取 cookie 值
   */
  getCookie(name: string): string | undefined;

  /**
   * 设置 cookie
   */
  setCookie(name: string, value: string, options?: CookieOptions): void;

  /**
   * 删除 cookie（设置过期）
   */
  deleteCookie(name: string): void;
}
