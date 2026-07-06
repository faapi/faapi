import { describe, it, expect, beforeEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { createMcpServer, type McpServer } from './mcpServer';
import { createMcpHandler, createMcpNodeHandler } from './faapiAdapter';

/**
 * faapiAdapter 测试
 *
 * 验证两种适配方式:
 * - createMcpHandler:返回 { POST, GET, DELETE },接收 faapi 风格 ctx({ request })
 * - createMcpNodeHandler:返回 Node.js 风格 (req, res) 处理函数,供 wrapHandler 使用
 *
 * 两者都应正确路由到 handleMcpRequest 并返回对应 Response。
 */
describe('faapiAdapter', () => {
  let mcp: McpServer;

  beforeEach(() => {
    mcp = createMcpServer({ name: 'adapter-test', version: '1.0.0' });
    mcp.tool('echo', {
      description: 'Echo text',
      input: { text: z.string() },
      handler: async ({ text }) => ({
        content: [{ type: 'text', text: `echo: ${text}` }],
      }),
    });
  });

  // ─── createMcpHandler ─────────────────────────────────

  describe('createMcpHandler', () => {
    it('返回 POST/GET/DELETE 三个函数', () => {
      const handlers = createMcpHandler(mcp);
      expect(typeof handlers.POST).toBe('function');
      expect(typeof handlers.GET).toBe('function');
      expect(typeof handlers.DELETE).toBe('function');
    });

    it('POST 处理 initialize 请求,返回 200 + Mcp-Session-Id', async () => {
      const { POST } = createMcpHandler(mcp);
      const res = await POST({
        request: new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Mcp-Session-Id')).toBeTruthy();
      const body = await res.json();
      expect(body.result.serverInfo.name).toBe('adapter-test');
    });

    it('POST 调用 tool 返回结果', async () => {
      const { POST } = createMcpHandler(mcp);
      // initialize
      const initRes = await POST({
        request: new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
        }),
      });
      const sid = initRes.headers.get('Mcp-Session-Id');

      // tools/call
      const callRes = await POST({
        request: new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Mcp-Session-Id': sid!,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'echo', arguments: { text: 'hi' } },
          }),
        }),
      });

      expect(callRes.status).toBe(200);
      const body = await callRes.json();
      expect(body.result.content[0].text).toBe('echo: hi');
    });

    it('GET 返回 200 + text/event-stream(SSE 流)', async () => {
      const { GET } = createMcpHandler(mcp);
      const res = await GET({
        request: new Request('http://localhost/mcp', { method: 'GET' }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
      expect(res.body).toBeInstanceOf(ReadableStream);
      // SSE 流不主动结束,立即取消避免定时器泄漏
      await res.body!.cancel();
    });

    it('DELETE 销毁会话返回 200', async () => {
      const { POST, DELETE } = createMcpHandler(mcp);
      // initialize
      const initRes = await POST({
        request: new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
        }),
      });
      const sid = initRes.headers.get('Mcp-Session-Id');

      // delete
      const delRes = await DELETE({
        request: new Request('http://localhost/mcp', {
          method: 'DELETE',
          headers: { 'Mcp-Session-Id': sid! },
        }),
      });
      expect(delRes.status).toBe(200);

      // 再用该 session 调用应 404
      const callRes = await POST({
        request: new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Mcp-Session-Id': sid!,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        }),
      });
      expect(callRes.status).toBe(404);
    });

    it('多个 handler 共享同一 mcp 实例(tools/sessions 隔离于其他 mcp)', async () => {
      // 第二个 mcp
      const mcp2 = createMcpServer({ name: 'other', version: '1.0.0' });
      mcp2.tool('only-here', {
        handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      });

      const a = createMcpHandler(mcp);
      const b = createMcpHandler(mcp2);

      // 都 initialize
      const initA = await a.POST({
        request: new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
        }),
      });
      const initB = await b.POST({
        request: new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
        }),
      });

      // A 列出 tools 应只有 echo,B 应只有 only-here
      const listA = await a.POST({
        request: new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Mcp-Session-Id': initA.headers.get('Mcp-Session-Id')!,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        }),
      });
      const listB = await b.POST({
        request: new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Mcp-Session-Id': initB.headers.get('Mcp-Session-Id')!,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        }),
      });

      const toolsA = (await listA.json()).result.tools.map((t: { name: string }) => t.name);
      const toolsB = (await listB.json()).result.tools.map((t: { name: string }) => t.name);
      expect(toolsA).toEqual(['echo']);
      expect(toolsB).toEqual(['only-here']);

      // A 的 session 不能用于 B
      const crossRes = await b.POST({
        request: new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Mcp-Session-Id': initA.headers.get('Mcp-Session-Id')!,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
        }),
      });
      expect(crossRes.status).toBe(404);
    });
  });

  // ─── createMcpNodeHandler ─────────────────────────────

  describe('createMcpNodeHandler', () => {
    /** Mock ServerResponse 捕获的数据 */
    interface MockResCapture {
      statusCode: number;
      headers: Record<string, string>;
      body: string;
    }

    /** Mock ServerResponse 类型:Writable + 捕获字段 */
    type MockRes = Writable &
      MockResCapture & {
        setHeader: (name: string, value: string) => void;
      };

    /**
     * 构造模拟 IncomingMessage。
     * 真正的 IncomingMessage 总是 Node.js Readable stream(即使无 body 也是空 stream),
     * 因此用 Readable.from 创建,确保 Readable.toWeb 能正确转换。
     */
    function makeNodeReq(
      method: string,
      body: unknown | null,
      headers: Record<string, string> = {},
      url = '/mcp',
    ): IncomingMessage {
      const finalHeaders: Record<string, string | string[] | undefined> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      };
      const buf =
        body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const stream = buf === null ? Readable.from([]) : Readable.from([buf]);
      return Object.assign(stream, {
        method,
        url,
        headers: finalHeaders,
      }) as unknown as IncomingMessage;
    }

    /** 构造多 chunk 模拟 IncomingMessage */
    function makeNodeReqMultiChunk(
      method: string,
      chunks: Buffer[],
      headers: Record<string, string> = {},
      url = '/mcp',
    ): IncomingMessage {
      const finalHeaders: Record<string, string | string[] | undefined> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      };
      const stream = Readable.from(chunks);
      return Object.assign(stream, {
        method,
        url,
        headers: finalHeaders,
      }) as unknown as IncomingMessage;
    }

    /**
     * 模拟 Node.js ServerResponse,基于 Writable 支持 pipe。
     * 捕获写入数据,通过 res.statusCode / res.__headers / res.__body 访问。
     */
    function makeNodeRes(): MockRes {
      const capture: MockResCapture = {
        statusCode: 200,
        headers: {},
        body: '',
      };
      const writable = new Writable({
        write(chunk, _enc, cb) {
          capture.body += chunk.toString('utf-8');
          cb();
        },
      });
      // 用 defineProperty 同步 statusCode 到 capture
      Object.defineProperty(writable, 'statusCode', {
        get: () => capture.statusCode,
        set: (v: number) => {
          capture.statusCode = v;
        },
        configurable: true,
      });
      Object.defineProperty(writable, 'headers', {
        get: () => capture.headers,
        configurable: true,
      });
      Object.defineProperty(writable, 'body', {
        get: () => capture.body,
        configurable: true,
      });
      Object.assign(writable, {
        setHeader(name: string, value: string) {
          capture.headers[name.toLowerCase()] = value;
        },
      });
      return writable as unknown as MockRes;
    }

    /** 调用 handler */
    async function call(
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
      req: IncomingMessage,
      res: MockRes,
    ): Promise<void> {
      await handler(req, res as unknown as ServerResponse);
    }

    it('POST initialize 返回 200 + Mcp-Session-Id', async () => {
      const handler = createMcpNodeHandler(mcp);
      const req = makeNodeReq('POST', { jsonrpc: '2.0', id: 1, method: 'initialize' });
      const res = makeNodeRes();

      await call(handler, req, res);

      expect(res.statusCode).toBe(200);
      expect(res.headers['mcp-session-id']).toBeTruthy();
      const body = JSON.parse(res.body);
      expect(body.result.serverInfo.name).toBe('adapter-test');
    });

    it('POST 调用 tool 返回结果', async () => {
      const handler = createMcpNodeHandler(mcp);

      const initReq = makeNodeReq('POST', { jsonrpc: '2.0', id: 1, method: 'initialize' });
      const initRes = makeNodeRes();
      await call(handler, initReq, initRes);
      const sid = initRes.headers['mcp-session-id'];

      const callReq = makeNodeReq(
        'POST',
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'echo', arguments: { text: 'from-node' } },
        },
        { 'mcp-session-id': sid! },
      );
      const callRes = makeNodeRes();
      await call(handler, callReq, callRes);

      expect(callRes.statusCode).toBe(200);
      const body = JSON.parse(callRes.body);
      expect(body.result.content[0].text).toBe('echo: from-node');
    });

    it('GET 返回 200 + text/event-stream(SSE 流)', async () => {
      const handler = createMcpNodeHandler(mcp);
      const req = makeNodeReq('GET', null);
      const res = makeNodeRes();
      // GET SSE 流不主动结束,收到初始 chunk 后模拟客户端断开(destroy 触发 'close')
      const originalWrite = res.write.bind(res) as (chunk: unknown, ...args: unknown[]) => boolean;
      let closed = false;
      res.write = ((chunk: unknown, ...args: unknown[]) => {
        const result = originalWrite(chunk, ...args);
        if (!closed) {
          closed = true;
          // 收到初始 chunk 后销毁 res,触发 'close' 结束 pipe
          process.nextTick(() => res.destroy());
        }
        return result;
      }) as typeof res.write;

      await call(handler, req, res);

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.body).toContain(': connected');
    });

    it('DELETE 销毁会话返回 200', async () => {
      const handler = createMcpNodeHandler(mcp);

      const initReq = makeNodeReq('POST', { jsonrpc: '2.0', id: 1, method: 'initialize' });
      const initRes = makeNodeRes();
      await call(handler, initReq, initRes);
      const sid = initRes.headers['mcp-session-id'];

      const delReq = makeNodeReq('DELETE', null, { 'mcp-session-id': sid! });
      const delRes = makeNodeRes();
      await call(handler, delReq, delRes);

      expect(delRes.statusCode).toBe(200);

      const callReq = makeNodeReq(
        'POST',
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { 'mcp-session-id': sid! },
      );
      const callRes = makeNodeRes();
      await call(handler, callReq, callRes);
      expect(callRes.statusCode).toBe(404);
    });

    it('数组 headers 正确处理(set-cookie 多值)', async () => {
      const handler = createMcpNodeHandler(mcp);
      const req = makeNodeReq(
        'POST',
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        {
          'set-cookie': 'ignored',
        },
      );
      req.headers['x-multi'] = ['a', 'b'];
      const res = makeNodeRes();

      await call(handler, req, res);

      expect(res.statusCode).toBe(200);
    });

    it('无 body 的 POST 返回 400 ParseError', async () => {
      const handler = createMcpNodeHandler(mcp);
      const req = makeNodeReq('POST', null);
      const res = makeNodeRes();

      await call(handler, req, res);

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(-32700);
    });

    it('DELETE 缺 Mcp-Session-Id 返回 400', async () => {
      const handler = createMcpNodeHandler(mcp);
      const req = makeNodeReq('DELETE', null);
      const res = makeNodeRes();

      await call(handler, req, res);

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(-32600);
    });

    it('多 chunk body 正确读取(chunked transfer)', async () => {
      const handler = createMcpNodeHandler(mcp);
      const chunks = [
        Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initia'),
        Buffer.from('lize","params":{"protocolVersion":"2025-06-18"}}'),
      ];
      const req = makeNodeReqMultiChunk('POST', chunks);
      const res = makeNodeRes();

      await call(handler, req, res);

      expect(res.statusCode).toBe(200);
      expect(res.headers['mcp-session-id']).toBeTruthy();
      const body = JSON.parse(res.body);
      expect(body.result.serverInfo.name).toBe('adapter-test');
    });

    it('大 body(>64KB)多 chunk 正确读取', async () => {
      const handler = createMcpNodeHandler(mcp);

      const initReq = makeNodeReq('POST', { jsonrpc: '2.0', id: 1, method: 'initialize' });
      const initRes = makeNodeRes();
      await call(handler, initReq, initRes);
      const sid = initRes.headers['mcp-session-id'];

      const bigText = 'x'.repeat(100_000);
      const payload = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: bigText } },
      };
      const payloadBuf = Buffer.from(JSON.stringify(payload));
      const chunkSize = Math.ceil(payloadBuf.length / 4);
      const chunks: Buffer[] = [];
      for (let i = 0; i < payloadBuf.length; i += chunkSize) {
        chunks.push(payloadBuf.subarray(i, i + chunkSize));
      }

      const req = makeNodeReqMultiChunk('POST', chunks, { 'mcp-session-id': sid! });
      const res = makeNodeRes();

      await call(handler, req, res);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.result.content[0].text).toBe(`echo: ${bigText}`);
    });
  });
});
