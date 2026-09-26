import { PassThrough, Readable } from 'node:stream';
import type { Server } from 'node:http';

/**
 * 无服务器注入（app.inject）的 mock HTTP 实现
 *
 * 从 createAppCore 拆出——约 110 行「手工模拟 IncomingMessage/ServerResponse + 走
 * 真实 request listener」的实现与编排主流程无关。真实请求链路（中间件/路由/校验/
 * handler）不受影响：mock 只替换传输层。
 */

export interface InjectOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  /**
   * 请求体，语义按类型区分（与 fastify inject 约定一致）：
   * - `string` / `Buffer` / `Uint8Array`：原样透传不二次编码（默认 content-type
   *   分别为 `text/plain` / `application/octet-stream`）
   * - 其他值（对象/数组等）：`JSON.stringify` 后发送，默认 content-type `application/json`
   *
   * 调用方显式传入的 `content-type` 头优先于默认值（string body +
   * `application/x-www-form-urlencoded` 可直接测 form 表单路由）。
   * 注意不要把 `JSON.stringify` 的结果当对象传——那会作为原始文本再被服务端
   * JSON 解析一次，得到字符串而非对象。
   */
  body?: unknown;
}

export interface InjectResponse {
  status: number;
  headers: Headers;
  /**
   * 响应字节按 JSON 反序列化的结果（非 JSON 回退字符串）——HTTP 语义，与真实客户端一致。
   * 序列化契约（Date → 毫秒时间戳、BigInt → 字符串等，JSON 原生类型之外全部转换）
   * 见 `src/utils/stringifyJson.md`，与真实 HTTP 响应完全相同
   */
  body: unknown;
}

/**
 * 执行一次无服务器注入
 *
 * 从 server 取当前 request listener（applyPluginWrappers 包装后的最终 handler）
 * 直接喂入 mock 的 req/res——完整链路（CORS/helmet/logger/全局中间件/路由匹配/
 * schema 校验/目录中间件/handler）与真实请求一致，仅传输层为内存 mock。
 *
 * 取 listeners 列表最后一个（applyPluginWrappers 包装后唯一 request listener）
 * 作为 handler。
 */
export function performInject(server: Server, injectOpts?: InjectOptions): Promise<InjectResponse> {
  const {
    method = 'GET',
    path: reqPath = '/',
    headers: reqHeaders = {},
    query,
    body,
  } = injectOpts ?? {};

  const queryStr = query
    ? '?' + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()
    : '';

  return new Promise<InjectResponse>((resolve, reject) => {
    // mockRes 需为 Writable Stream（PassThrough）以支持 sendNodeResponse 的 pipe 路径
    // （handler 返回值被自动包裹后产生 JSON body，走 nodeStream.pipe(res)）
    const chunks: Buffer[] = [];
    const mockRes = new PassThrough() as PassThrough & {
      statusCode: number;
      _headers: Record<string, string>;
      setHeader(name: string, value: string): void;
      appendHeader(name: string, value: string): void;
      writeHead(status: number, headers?: Record<string, string>): void;
    };
    mockRes.statusCode = 200;
    mockRes._headers = {};
    mockRes.setHeader = function (name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
    };
    mockRes.appendHeader = function (name: string, value: string) {
      const key = name.toLowerCase();
      const existing = this._headers[key];
      this._headers[key] = existing ? `${existing}, ${value}` : value;
    };
    mockRes.writeHead = function (status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      if (headers) {
        Object.assign(this._headers, headers);
      }
    };

    mockRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    mockRes.on('error', reject);
    mockRes.on('finish', () => {
      const bodyBuf = Buffer.concat(chunks);
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyBuf.toString());
      } catch {
        parsed = bodyBuf.toString();
      }
      resolve({
        status: mockRes.statusCode,
        headers: new Headers(mockRes._headers as Record<string, string>),
        body: parsed,
      });
    });

    const listeners = server.listeners('request');
    const handler = listeners[listeners.length - 1];
    if (typeof handler !== 'function') {
      reject(new Error('No request handler found'));
      return;
    }

    // body 按类型区分语义（与 fastify inject 一致）：string/Uint8Array 原样透传
    // 不二次编码，其他值 JSON.stringify；调用方显式 content-type 优先于默认值
    let payload: Buffer | undefined;
    let defaultContentType: string | undefined;
    if (body !== undefined) {
      if (typeof body === 'string') {
        payload = Buffer.from(body, 'utf-8');
        defaultContentType = 'text/plain';
      } else if (body instanceof Uint8Array) {
        payload = Buffer.from(body);
        defaultContentType = 'application/octet-stream';
      } else {
        payload = Buffer.from(JSON.stringify(body));
        defaultContentType = 'application/json';
      }
    }

    const mockReq: Readable & {
      method?: string;
      url?: string;
      headers?: Record<string, string | undefined>;
      socket?: { remoteAddress?: string };
    } = Readable.from(payload !== undefined ? [payload] : []);
    mockReq.method = method;
    mockReq.url = `${reqPath}${queryStr}`;
    const hasCallerContentType = 'content-type' in reqHeaders || 'Content-Type' in reqHeaders;
    mockReq.headers = {
      ...reqHeaders,
      host: 'localhost',
      ...(payload !== undefined && !hasCallerContentType
        ? { 'content-type': defaultContentType }
        : {}),
    };
    mockReq.socket = { remoteAddress: '127.0.0.1' };

    handler(
      mockReq as unknown as import('node:http').IncomingMessage,
      mockRes as unknown as import('node:http').ServerResponse,
    );
  });
}
