import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { createMcpServer, type McpServer } from './mcpServer';
import { handleMcpRequest } from './streamableHttp';

describe('handleMcpRequest (Streamable HTTP)', () => {
  let mcp: McpServer;

  beforeEach(() => {
    mcp = createMcpServer({ name: 'test-server', version: '1.0.0' });
    mcp.tool('hello', {
      description: 'Say hello',
      input: { name: z.string() },
      handler: async ({ name }) => ({
        content: [{ type: 'text', text: `Hello, ${name}!` }],
      }),
    });
  });

  // ─── POST: initialize ──────────────────────────────────

  describe('POST initialize', () => {
    it('返回 200 + 协议版本 + serverInfo', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18' },
        }),
      });

      const res = await handleMcpRequest(req, mcp);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');

      // 应包含 Mcp-Session-Id header
      const sessionId = res.headers.get('Mcp-Session-Id');
      expect(sessionId).toBeTruthy();

      const body = await res.json();
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(1);
      expect(body.result.protocolVersion).toBe('2025-06-18');
      expect(body.result.serverInfo.name).toBe('test-server');
      expect(body.result.capabilities.tools.listChanged).toBe(false);
    });

    it('后续请求需带 Mcp-Session-Id', async () => {
      // 先 initialize
      const initReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      const initRes = await handleMcpRequest(initReq, mcp);
      const sessionId = initRes.headers.get('Mcp-Session-Id');
      expect(sessionId).toBeTruthy();

      // tools/list 带 session
      const listReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      const listRes = await handleMcpRequest(listReq, mcp);
      expect(listRes.status).toBe(200);
      const body = await listRes.json();
      expect(body.result.tools).toHaveLength(1);
      expect(body.result.tools[0].name).toBe('hello');
    });

    it('不存在的 session ID 返回 404', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': 'nonexistent-session',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      const res = await handleMcpRequest(req, mcp);
      expect(res.status).toBe(404);
    });
  });

  // ─── POST: tools/call ─────────────────────────────────

  describe('POST tools/call', () => {
    it('调用 tool 返回结果', async () => {
      // 先 initialize 获取 session
      const initReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      const initRes = await handleMcpRequest(initReq, mcp);
      const sessionId = initRes.headers.get('Mcp-Session-Id');

      const callReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'hello', arguments: { name: 'World' } },
        }),
      });
      const res = await handleMcpRequest(callReq, mcp);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.content[0].text).toBe('Hello, World!');
    });
  });

  // ─── POST: notification ───────────────────────────────

  describe('POST notification', () => {
    it('通知返回 202 Accepted', async () => {
      // 先 initialize
      const initReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      const initRes = await handleMcpRequest(initReq, mcp);
      const sessionId = initRes.headers.get('Mcp-Session-Id');

      // 发送 notifications/initialized
      const notifReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      const res = await handleMcpRequest(notifReq, mcp);
      expect(res.status).toBe(202);
    });
  });

  // ─── POST: 错误场景 ───────────────────────────────────

  describe('POST 错误场景', () => {
    it('无效 JSON 返回 400 ParseError', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: 'not json',
      });
      const res = await handleMcpRequest(req, mcp);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe(-32700);
    });

    it('无效 JSON-RPC 消息返回 400', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' }),
      });
      const res = await handleMcpRequest(req, mcp);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe(-32700);
    });
  });

  // ─── POST: 协议头校验 ───────────────────────────────

  describe('POST 协议头校验', () => {
    it('initialize 请求豁免 Accept 头校验', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      const res = await handleMcpRequest(req, mcp);
      expect(res.status).toBe(200);
    });

    it('非 initialize 请求缺失 Accept 头返回 400', async () => {
      // 先 initialize(豁免)
      const initReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      const initRes = await handleMcpRequest(initReq, mcp);
      const sid = initRes.headers.get('Mcp-Session-Id');

      // tools/list 无 Accept 头
      const listReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sid!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      const res = await handleMcpRequest(listReq, mcp);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe(-32600);
      expect(body.error.message).toContain('Accept');
    });

    it('非 initialize 请求 Accept 缺少 text/event-stream 返回 400', async () => {
      const initReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      const initRes = await handleMcpRequest(initReq, mcp);
      const sid = initRes.headers.get('Mcp-Session-Id');

      const listReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Mcp-Session-Id': sid!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      const res = await handleMcpRequest(listReq, mcp);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe(-32600);
    });

    it('非 initialize 请求 Accept 缺少 application/json 返回 400', async () => {
      const initReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      const initRes = await handleMcpRequest(initReq, mcp);
      const sid = initRes.headers.get('Mcp-Session-Id');

      const listReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Mcp-Session-Id': sid!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      const res = await handleMcpRequest(listReq, mcp);
      expect(res.status).toBe(400);
    });

    it('Accept 头含两者时通过校验', async () => {
      const initReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      const initRes = await handleMcpRequest(initReq, mcp);
      const sid = initRes.headers.get('Mcp-Session-Id');

      const listReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sid!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      const res = await handleMcpRequest(listReq, mcp);
      expect(res.status).toBe(200);
    });

    it('MCP-Protocol-Version 头缺失时宽松处理(不拒绝)', async () => {
      const initReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      const initRes = await handleMcpRequest(initReq, mcp);
      const sid = initRes.headers.get('Mcp-Session-Id');

      // 不带 MCP-Protocol-Version 头,应宽松处理
      const listReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sid!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      const res = await handleMcpRequest(listReq, mcp);
      expect(res.status).toBe(200);
    });
  });

  // ─── GET ─────────────────────────────────────────────

  describe('GET', () => {
    it('返回 200 + text/event-stream', async () => {
      const req = new Request('http://localhost/mcp', { method: 'GET' });
      const res = await handleMcpRequest(req, mcp);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
      expect(res.body).toBeInstanceOf(ReadableStream);
      // 立即取消,避免定时器泄漏
      await res.body!.cancel();
    });

    it('SSE 流推送心跳(自定义短间隔便于测试)', async () => {
      const mcpWithFastHeartbeat = createMcpServer({
        name: 'fast',
        version: '1.0.0',
        sseHeartbeatMs: 30,
      });
      const req = new Request('http://localhost/mcp', { method: 'GET' });
      const res = await handleMcpRequest(req, mcpWithFastHeartbeat);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // 读取第一个 chunk(应为初始连接消息或心跳)
      const { value: firstChunk } = await reader.read();
      const firstText = decoder.decode(firstChunk);
      expect(firstText).toContain(':'); // SSE comment 行以 : 开头

      // 读取第二个 chunk(心跳)
      const { value: secondChunk } = await reader.read();
      const secondText = decoder.decode(secondChunk);
      expect(secondText).toContain(':');

      await reader.cancel();
    });

    it('客户端 cancel 后流正常关闭(无定时器泄漏)', async () => {
      const mcpWithFastHeartbeat = createMcpServer({
        name: 'cancel-test',
        version: '1.0.0',
        sseHeartbeatMs: 30,
      });
      const req = new Request('http://localhost/mcp', { method: 'GET' });
      const res = await handleMcpRequest(req, mcpWithFastHeartbeat);

      const reader = res.body!.getReader();
      const { value } = await reader.read();
      expect(value).toBeDefined();

      // cancel 后应正常关闭,不抛错
      await reader.cancel();

      // 再次 read 应返回 done
      const { done } = await reader.read();
      expect(done).toBe(true);
    });

    it('GET 携带 Mcp-Session-Id 时注册 SSE 订阅者', async () => {
      // 先 initialize 获取 session
      const initReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      const initRes = await handleMcpRequest(initReq, mcp);
      const sid = initRes.headers.get('Mcp-Session-Id')!;

      // 检查 session 当前订阅者为 0
      const session = mcp.getSessionManager().get(sid);
      expect(session).toBeDefined();
      expect(session!.subscribers.size).toBe(0);

      // GET 携带 session id
      const req = new Request('http://localhost/mcp', {
        method: 'GET',
        headers: { 'Mcp-Session-Id': sid },
      });
      const res = await handleMcpRequest(req, mcp);
      expect(res.status).toBe(200);

      // 读取一个 chunk 触发 stream start(注册订阅者)
      const reader = res.body!.getReader();
      await reader.read();

      // 检查订阅者已注册
      const sessionAfter = mcp.getSessionManager().get(sid);
      expect(sessionAfter!.subscribers.size).toBe(1);

      // cancel 后订阅者应被注销
      await reader.cancel();
      // 给 cancel 处理一点时间
      await new Promise((r) => setTimeout(r, 10));
      const sessionFinal = mcp.getSessionManager().get(sid);
      expect(sessionFinal!.subscribers.size).toBe(0);
    });

    it('GET 携带 Mcp-Session-Id 时服务端 sendLogging 推送到 SSE 流', async () => {
      // 先 initialize
      const initReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      const initRes = await handleMcpRequest(initReq, mcp);
      const sid = initRes.headers.get('Mcp-Session-Id')!;

      // GET 携带 session id,打开 SSE 流
      const getReq = new Request('http://localhost/mcp', {
        method: 'GET',
        headers: { 'Mcp-Session-Id': sid },
      });
      const getRes = await handleMcpRequest(getReq, mcp);
      const reader = getRes.body!.getReader();

      // 读取初始 chunk(连接确认),触发订阅者注册
      await reader.read();

      // 服务端推送日志
      mcp.sendLogging(sid, 'info', { msg: 'pushed via GET SSE' }, 'test');

      // 读取推送的 chunk
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain('notifications/message');
      expect(text).toContain('"level":"info"');
      expect(text).toContain('"msg":"pushed via GET SSE"');

      await reader.cancel();
    });

    it('GET 无 Mcp-Session-Id 时不注册订阅者(仅心跳)', async () => {
      const req = new Request('http://localhost/mcp', { method: 'GET' });
      const res = await handleMcpRequest(req, mcp);
      const reader = res.body!.getReader();
      await reader.read();

      // 无 session,sendLogging 应静默丢弃(不影响流)
      mcp.sendLogging('any-id', 'info', { msg: 'no session' });

      // 读取下一条应为心跳(: 开头),而非 notifications/message
      // 注:可能需要等待心跳,这里仅验证不抛错
      await reader.cancel();
    });

    it('GET 携带不存在的 Mcp-Session-Id 时仍打开流(但不注册订阅者)', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'GET',
        headers: { 'Mcp-Session-Id': 'nonexistent' },
      });
      const res = await handleMcpRequest(req, mcp);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain(':');
      await reader.cancel();
    });
  });

  // ─── DELETE ──────────────────────────────────────────

  describe('DELETE', () => {
    it('销毁会话返回 200', async () => {
      // 先 initialize
      const initReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      const initRes = await handleMcpRequest(initReq, mcp);
      const sessionId = initRes.headers.get('Mcp-Session-Id');
      expect(mcp.getSessionManager().size).toBe(1);

      // DELETE
      const delReq = new Request('http://localhost/mcp', {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': sessionId! },
      });
      const res = await handleMcpRequest(delReq, mcp);
      expect(res.status).toBe(200);
      expect(mcp.getSessionManager().size).toBe(0);
    });

    it('无 Mcp-Session-Id 返回 400', async () => {
      const req = new Request('http://localhost/mcp', { method: 'DELETE' });
      const res = await handleMcpRequest(req, mcp);
      expect(res.status).toBe(400);
    });

    it('不存在的 session 返回 404', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': 'nonexistent' },
      });
      const res = await handleMcpRequest(req, mcp);
      expect(res.status).toBe(404);
    });
  });

  // ─── ping ─────────────────────────────────────────────

  describe('POST ping', () => {
    it('返回空结果', async () => {
      // 先 initialize
      const initReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      const initRes = await handleMcpRequest(initReq, mcp);
      const sessionId = initRes.headers.get('Mcp-Session-Id');

      const pingReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      });
      const res = await handleMcpRequest(pingReq, mcp);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toEqual({});
    });
  });
});
