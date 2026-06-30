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
