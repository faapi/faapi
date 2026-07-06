/**
 * faapi 适配器：把 MCP Server 挂载到 faapi 路由
 *
 * 两种集成方式：
 *
 * 1. handler 风格（推荐）——在 handler.ts 中使用：
 *    ```ts
 *    // api/mcp/handler.ts
 *    import { createMcpServer, createMcpHandler } from '@faapi/mcp';
 *    const mcp = createMcpServer({ name: 'my-app', version: '1.0.0' });
 *    mcp.tool('hello', { ... });
 *    export const { POST, GET, DELETE } = createMcpHandler(mcp);
 *    ```
 *
 * 2. 插件风格——在 faapi.config.ts 中声明：
 *    ```ts
 *    plugins: [['@faapi/mcp', { path: '/mcp' }]]
 *    ```
 *    需配合 mcp.tool() 注册（通常在 lifecycle.onReady 中）。
 *
 * 函数即接口：MCP endpoint 就是 faapi 的一个路由。
 */

import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from './mcpServer';
import { handleMcpRequest } from './streamableHttp';

/**
 * 创建 faapi handler 函数
 *
 * 返回 { POST, GET, DELETE }，可直接在 handler.ts 中导出。
 * faapi 按参数名注入 ctx，函数内通过 ctx.request 获取 Web Request。
 */
export function createMcpHandler(mcp: McpServer): {
  POST: (ctx: { request: Request }) => Promise<Response>;
  GET: (ctx: { request: Request }) => Promise<Response>;
  DELETE: (ctx: { request: Request }) => Promise<Response>;
} {
  const handler = async (ctx: { request: Request }): Promise<Response> => {
    return handleMcpRequest(ctx.request, mcp);
  };
  return { POST: handler, GET: handler, DELETE: handler };
}

/**
 * 创建 Node.js 请求处理函数（供 wrapHandler 使用）
 *
 * 用于 faapi 插件场景：插件通过 wrapHandler 拦截指定路径，
 * 将 Node.js IncomingMessage/ServerResponse 转为 Web Request 处理。
 *
 * 使用 Node.js 原生 `Readable.toWeb(req)` 转换 body,正确处理 chunked transfer
 * (多 chunk 累积)、backpressure 和 stream error。
 */
export function createMcpNodeHandler(
  mcp: McpServer,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) headers.set(key, v);
      } else if (value !== undefined) {
        headers.set(key, value);
      }
    }

    const method = req.method ?? 'GET';
    // GET/HEAD/DELETE 无 body(DELETE 可能有 body 但 MCP 协议中 DELETE 用于销毁会话,无 body)
    const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE';

    // 使用 Node.js 原生 Readable.toWeb 转换,正确处理多 chunk、backpressure、error
    const body = hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined;

    const request = new Request(url, {
      method,
      headers,
      ...(body && { body, duplex: 'half' as const }),
    } as RequestInit);

    const response = await handleMcpRequest(request, mcp);

    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    if (response.body) {
      // 用 pipe 处理流式响应(SSE 流),避免 text() 阻塞
      // 注意:SSE 流不主动结束,监听 'close'(客户端断开或 res 销毁)而非仅 'finish'
      const nodeStream = Readable.fromWeb(response.body as never);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };
        nodeStream.on('error', (err) => settle(err));
        res.on('error', (err: Error) => settle(err));
        res.on('finish', () => settle());
        res.on('close', () => settle());
        nodeStream.pipe(res);
      });
      return;
    }

    res.end();
  };
}
