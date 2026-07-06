import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createMcpServer, PROTOCOL_VERSION } from './mcpServer';
import { isResultResponse, isErrorResponse, type JsonRpcRequest } from './jsonRpc';

function makeRequest(id: string | number, method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) };
}

describe('McpServer', () => {
  // ─── tool 注册 ───────────────────────────────────────

  describe('tool 注册', () => {
    it('注册并列出 tool', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.tool('hello', {
        description: 'Say hello',
        input: { name: z.string() },
        handler: async () => ({ content: [{ type: 'text', text: 'hi' }] }),
      });
      expect(mcp.listTools()).toEqual(['hello']);
    });

    it('重复注册同名 tool 抛错', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.tool('hello', { handler: async () => ({ content: [] }) });
      expect(() => mcp.tool('hello', { handler: async () => ({ content: [] }) })).toThrow(
        /already registered/,
      );
    });

    it('listChanged: false(默认)声明对应 capability.removeTool 存在但不主动通知客户端', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.tool('hello', { handler: async () => ({ content: [] }) });
      // removeTool API 始终存在(用于 dev 热替换等)
      expect(typeof (mcp as unknown as { removeTool?: unknown }).removeTool).toBe('function');

      // initialize 响应声明 listChanged: false(默认)
      const res = await mcp.handleJsonRpc(makeRequest(1, 'initialize'), undefined);
      const result = (res as { result: Record<string, unknown> }).result;
      expect((result.capabilities as { tools: { listChanged: boolean } }).tools.listChanged).toBe(
        false,
      );

      // 删除 tool(不推送通知,因 listChanged: false)
      const deleted = mcp.removeTool('hello');
      expect(deleted).toBe(true);
      expect(mcp.listTools()).toEqual([]);
    });
  });

  // ─── initialize ──────────────────────────────────────

  describe('initialize', () => {
    it('返回协议版本、capabilities 和 serverInfo', async () => {
      const mcp = createMcpServer({ name: 'my-app', version: '1.2.3', title: 'My App' });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'initialize', {
          protocolVersion: '2025-06-18',
          clientInfo: { name: 'claude', version: '1.0.0' },
        }),
        undefined,
      );
      expect(res).not.toBeNull();
      expect(isResultResponse(res!)).toBe(true);
      const result = (res as { result: Record<string, unknown> }).result;
      expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(result.capabilities).toEqual({ tools: { listChanged: false }, logging: {} });
      expect(result.serverInfo).toEqual({ name: 'my-app', version: '1.2.3', title: 'My App' });
    });

    it('客户端请求不支持的版本时降级到最新', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'initialize', { protocolVersion: '9999-01-01' }),
        undefined,
      );
      const result = (res as { result: Record<string, unknown> }).result;
      expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    });

    it('填充 clientInfo 到 session', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();
      await mcp.handleJsonRpc(
        makeRequest(1, 'initialize', {
          protocolVersion: '2025-06-18',
          clientInfo: { name: 'test-client', version: '2.0.0' },
        }),
        session,
      );
      expect(session.protocolVersion).toBe('2025-06-18');
      expect(session.clientInfo).toEqual({ name: 'test-client', version: '2.0.0' });
    });

    it('无 session 时自动创建（直接调用 handleJsonRpc 场景）', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      expect(mcp.getSessionManager().size).toBe(0);
      await mcp.handleJsonRpc(makeRequest(1, 'initialize'), undefined);
      expect(mcp.getSessionManager().size).toBe(1);
    });

    it('instructions 字段可选', async () => {
      const mcp = createMcpServer({
        name: 'test',
        version: '1.0.0',
        instructions: 'Use carefully',
      });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'initialize'), undefined);
      const result = (res as { result: Record<string, unknown> }).result;
      expect(result.instructions).toBe('Use carefully');
    });

    it('sessionTtl 配置透传到 SessionManager', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0', sessionTtl: 50 });
      const session = mcp.getSessionManager().create();
      expect(mcp.getSessionManager().get(session.id)).toBeDefined();

      // 等待 100ms 超过 50ms TTL
      const start = Date.now();
      while (Date.now() - start < 100) {
        // busy wait
      }
      expect(mcp.getSessionManager().get(session.id)).toBeUndefined();
    });

    it('sessionTtl: 0 表示永不过期', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0', sessionTtl: 0 });
      const session = mcp.getSessionManager().create();
      // 等待 50ms,不应过期
      const start = Date.now();
      while (Date.now() - start < 50) {
        // busy wait
      }
      expect(mcp.getSessionManager().get(session.id)).toBeDefined();
    });

    it('未配置 sessionTtl 时使用默认 30 分钟', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();
      // 等待 50ms,不应过期(默认 30 分钟)
      const start = Date.now();
      while (Date.now() - start < 50) {
        // busy wait
      }
      expect(mcp.getSessionManager().get(session.id)).toBeDefined();
    });
  });

  // ─── ping ────────────────────────────────────────────

  it('ping 返回空结果', async () => {
    const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
    const res = await mcp.handleJsonRpc(makeRequest(1, 'ping'), undefined);
    expect(isResultResponse(res!)).toBe(true);
    expect((res as { result: unknown }).result).toEqual({});
  });

  // ─── tools/list ──────────────────────────────────────

  describe('tools/list', () => {
    it('返回已注册 tool 列表含 JSON Schema', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.tool('get_user', {
        description: 'Get user by ID',
        input: { userId: z.string().describe('User ID') },
        handler: async () => ({ content: [] }),
      });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'tools/list'), undefined);
      const result = (res as { result: { tools: Array<Record<string, unknown>> } }).result;
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]!.name).toBe('get_user');
      expect(result.tools[0]!.description).toBe('Get user by ID');
      const schema = result.tools[0]!.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      expect((schema.properties as Record<string, unknown>).userId).toBeDefined();
      expect(schema.required).toEqual(['userId']);
    });

    it('无 input 的 tool 返回空 schema', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.tool('ping', {
        description: 'Health check',
        handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
      });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'tools/list'), undefined);
      const result = (res as { result: { tools: Array<Record<string, unknown>> } }).result;
      expect(result.tools[0]!.inputSchema).toEqual({ type: 'object', properties: {} });
    });
  });

  // ─── tools/call ──────────────────────────────────────

  describe('tools/call', () => {
    it('调用 tool 并返回结果', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.tool('echo', {
        input: { message: z.string() },
        handler: async ({ message }) => ({
          content: [{ type: 'text', text: `echo: ${message}` }],
        }),
      });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'tools/call', { name: 'echo', arguments: { message: 'hello' } }),
        undefined,
      );
      expect(isResultResponse(res!)).toBe(true);
      const result = (res as { result: { content: Array<{ text: string }> } }).result;
      expect(result.content[0]!.text).toBe('echo: hello');
    });

    it('未知 tool 返回 InvalidParams 错误', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'tools/call', { name: 'nonexistent' }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      const error = (res as { error: { code: number; message: string } }).error;
      expect(error.code).toBe(-32602);
      expect(error.message).toContain('Unknown tool');
    });

    it('参数校验失败返回 InvalidParams 错误', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.tool('echo', {
        input: { message: z.string() },
        handler: async () => ({ content: [] }),
      });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'tools/call', { name: 'echo', arguments: { message: 123 } }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      const error = (res as { error: { code: number } }).error;
      expect(error.code).toBe(-32602);
    });

    it('handler 抛错返回 isError: true', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.tool('fail', {
        handler: async () => {
          throw new Error('Something went wrong');
        },
      });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'tools/call', { name: 'fail' }),
        undefined,
      );
      expect(isResultResponse(res!)).toBe(true);
      const result = (res as { result: { isError: boolean; content: Array<{ text: string }> } })
        .result;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Something went wrong');
    });

    it('无 arguments 时 handler 收到空对象', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      let receivedArgs: Record<string, unknown> | null = null;
      mcp.tool('noop', {
        handler: async (args) => {
          receivedArgs = args;
          return { content: [] };
        },
      });
      await mcp.handleJsonRpc(makeRequest(1, 'tools/call', { name: 'noop' }), undefined);
      expect(receivedArgs).toEqual({});
    });

    it('ToolCallExtra 包含 sessionId', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      let extraSessionId = '';
      mcp.tool('test', {
        handler: async (_, extra) => {
          extraSessionId = extra.sessionId;
          return { content: [] };
        },
      });
      const session = mcp.getSessionManager().create();
      await mcp.handleJsonRpc(makeRequest(1, 'tools/call', { name: 'test' }), session);
      expect(extraSessionId).toBe(session.id);
    });
  });

  // ─── MethodNotFound ──────────────────────────────────

  it('未知 method 返回 MethodNotFound', async () => {
    const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
    const res = await mcp.handleJsonRpc(makeRequest(1, 'unknown/method'), undefined);
    expect(isErrorResponse(res!)).toBe(true);
    const error = (res as { error: { code: number; message: string } }).error;
    expect(error.code).toBe(-32601);
    expect(error.message).toContain('unknown/method');
  });

  // ─── notifications ───────────────────────────────────

  it('notifications/initialized 标记 session 为已初始化', async () => {
    const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
    const session = mcp.getSessionManager().create();
    expect(session.initialized).toBe(false);
    await mcp.handleJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    expect(session.initialized).toBe(true);
  });

  // ─── capability 自动协商 ─────────────────────────────

  describe('capability 自动协商', () => {
    it('仅注册 tools:capabilities 只含 tools + logging', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.tool('hello', { handler: async () => ({ content: [] }) });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'initialize'), undefined);
      const result = (res as { result: { capabilities: Record<string, unknown> } }).result;
      expect(result.capabilities).toEqual({ tools: { listChanged: false }, logging: {} });
    });

    it('注册 resources:capabilities 含 resources + subscribe + logging', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://docs/readme', {
        name: 'readme',
        read: async () => ({ contents: [] }),
      });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'initialize'), undefined);
      const result = (res as { result: { capabilities: Record<string, unknown> } }).result;
      expect(result.capabilities).toEqual({
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: true },
        logging: {},
      });
    });

    it('注册 prompts:capabilities 含 prompts + logging', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('greet', {
        get: async () => ({ messages: [] }),
      });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'initialize'), undefined);
      const result = (res as { result: { capabilities: Record<string, unknown> } }).result;
      expect(result.capabilities).toEqual({
        tools: { listChanged: false },
        prompts: { listChanged: false },
        logging: {},
      });
    });

    it('全部注册:capabilities 含三者 + subscribe + logging', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.tool('hello', { handler: async () => ({ content: [] }) });
      mcp.resource('file://docs/readme', {
        name: 'readme',
        read: async () => ({ contents: [] }),
      });
      mcp.prompt('greet', {
        get: async () => ({ messages: [] }),
      });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'initialize'), undefined);
      const result = (res as { result: { capabilities: Record<string, unknown> } }).result;
      expect(result.capabilities).toEqual({
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: true },
        prompts: { listChanged: false },
        logging: {},
      });
    });
  });

  // ─── resources/list ─────────────────────────────────

  describe('resources/list', () => {
    it('返回已注册资源列表', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://docs/readme', {
        name: 'readme',
        description: 'Project README',
        mimeType: 'text/markdown',
        read: async () => ({ contents: [] }),
      });
      mcp.resource('file://config/app.json', {
        name: 'config',
        mimeType: 'application/json',
        read: async () => ({ contents: [] }),
      });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'resources/list'), undefined);
      expect(isResultResponse(res!)).toBe(true);
      const result = (res as { result: { resources: Array<Record<string, unknown>> } }).result;
      expect(result.resources).toHaveLength(2);
      expect(result.resources[0]!.uri).toBe('file://docs/readme');
      expect(result.resources[0]!.name).toBe('readme');
      expect(result.resources[0]!.description).toBe('Project README');
      expect(result.resources[0]!.mimeType).toBe('text/markdown');
      // 第二个资源无 description
      expect(result.resources[1]!.uri).toBe('file://config/app.json');
      expect(result.resources[1]!.description).toBeUndefined();
    });

    it('无资源注册时返回空列表', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'resources/list'), undefined);
      const result = (res as { result: { resources: unknown[] } }).result;
      expect(result.resources).toEqual([]);
    });
  });

  // ─── resources/read ─────────────────────────────────

  describe('resources/read', () => {
    it('调用 read handler 返回 contents', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://docs/readme', {
        name: 'readme',
        mimeType: 'text/markdown',
        read: async (uri) => ({
          contents: [{ uri, mimeType: 'text/markdown', text: '# Hello' }],
        }),
      });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'resources/read', { uri: 'file://docs/readme' }),
        undefined,
      );
      expect(isResultResponse(res!)).toBe(true);
      const result = (res as { result: { contents: Array<Record<string, unknown>> } }).result;
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]!.uri).toBe('file://docs/readme');
      expect(result.contents[0]!.text).toBe('# Hello');
    });

    it('read handler 接收正确的 uri 参数', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      let receivedUri = '';
      mcp.resource('file://data', {
        name: 'data',
        read: async (uri) => {
          receivedUri = uri;
          return { contents: [] };
        },
      });
      await mcp.handleJsonRpc(makeRequest(1, 'resources/read', { uri: 'file://data' }), undefined);
      expect(receivedUri).toBe('file://data');
    });

    it('缺少 uri 参数返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://docs', { name: 'docs', read: async () => ({ contents: [] }) });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'resources/read', {}), undefined);
      expect(isErrorResponse(res!)).toBe(true);
      const error = (res as { error: { code: number; message: string } }).error;
      expect(error.code).toBe(-32602);
      expect(error.message).toContain('uri');
    });

    it('未注册的 uri 返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'resources/read', { uri: 'file://nonexistent' }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      const error = (res as { error: { code: number; message: string } }).error;
      expect(error.code).toBe(-32602);
      expect(error.message).toContain('Unknown resource');
    });

    it('read handler 抛错返回 InternalError', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://broken', {
        name: 'broken',
        read: async () => {
          throw new Error('Read failed');
        },
      });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'resources/read', { uri: 'file://broken' }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      const error = (res as { error: { code: number; message: string } }).error;
      expect(error.code).toBe(-32603);
      expect(error.message).toContain('Read failed');
    });
  });

  // ─── prompts/list ───────────────────────────────────

  describe('prompts/list', () => {
    it('返回已注册 prompt 列表含参数定义', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('greet', {
        description: 'Greeting prompt',
        arguments: [
          { name: 'userName', description: 'User name', required: true },
          { name: 'language', required: false },
        ],
        get: async () => ({ messages: [] }),
      });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'prompts/list'), undefined);
      expect(isResultResponse(res!)).toBe(true);
      const result = (res as { result: { prompts: Array<Record<string, unknown>> } }).result;
      expect(result.prompts).toHaveLength(1);
      expect(result.prompts[0]!.name).toBe('greet');
      expect(result.prompts[0]!.description).toBe('Greeting prompt');
      const args = result.prompts[0]!.arguments as Array<Record<string, unknown>>;
      expect(args).toHaveLength(2);
      expect(args[0]!.name).toBe('userName');
      expect(args[0]!.required).toBe(true);
      expect(args[1]!.name).toBe('language');
      expect(args[1]!.required).toBe(false);
    });

    it('无 arguments 的 prompt 不输出 arguments 字段', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('simple', {
        get: async () => ({ messages: [] }),
      });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'prompts/list'), undefined);
      const result = (res as { result: { prompts: Array<Record<string, unknown>> } }).result;
      expect(result.prompts[0]!.arguments).toBeUndefined();
    });
  });

  // ─── prompts/get ────────────────────────────────────

  describe('prompts/get', () => {
    it('调用 get handler 返回 messages', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('greet', {
        arguments: [{ name: 'userName', required: true }],
        get: async (args) => ({
          messages: [
            { role: 'user', content: { type: 'text', text: `Hello, ${args.userName}!` } },
            { role: 'assistant', content: { type: 'text', text: 'Hi there' } },
          ],
        }),
      });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'prompts/get', { name: 'greet', arguments: { userName: 'Alice' } }),
        undefined,
      );
      expect(isResultResponse(res!)).toBe(true);
      const result = (res as { result: { messages: Array<Record<string, unknown>> } }).result;
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]!.role).toBe('user');
      const content0 = result.messages[0]!.content as Record<string, unknown>;
      expect(content0.type).toBe('text');
      expect(content0.text).toBe('Hello, Alice!');
    });

    it('get handler 接收正确的 arguments', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      let receivedArgs: Record<string, string> | null = null;
      mcp.prompt('test', {
        get: async (args) => {
          receivedArgs = args;
          return { messages: [] };
        },
      });
      await mcp.handleJsonRpc(
        makeRequest(1, 'prompts/get', { name: 'test', arguments: { key: 'value' } }),
        undefined,
      );
      expect(receivedArgs).toEqual({ key: 'value' });
    });

    it('无 arguments 时 handler 收到空对象', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      let receivedArgs: Record<string, string> | null = null;
      mcp.prompt('test', {
        get: async (args) => {
          receivedArgs = args;
          return { messages: [] };
        },
      });
      await mcp.handleJsonRpc(makeRequest(1, 'prompts/get', { name: 'test' }), undefined);
      expect(receivedArgs).toEqual({});
    });

    it('缺少 name 参数返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('test', { get: async () => ({ messages: [] }) });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'prompts/get', {}), undefined);
      expect(isErrorResponse(res!)).toBe(true);
      const error = (res as { error: { code: number; message: string } }).error;
      expect(error.code).toBe(-32602);
      expect(error.message).toContain('name');
    });

    it('未注册的 prompt 返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'prompts/get', { name: 'nonexistent' }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      const error = (res as { error: { code: number; message: string } }).error;
      expect(error.code).toBe(-32602);
      expect(error.message).toContain('Unknown prompt');
    });

    it('get handler 抛错返回 InternalError', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('broken', {
        get: async () => {
          throw new Error('Prompt generation failed');
        },
      });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'prompts/get', { name: 'broken' }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      const error = (res as { error: { code: number; message: string } }).error;
      expect(error.code).toBe(-32603);
      expect(error.message).toContain('Prompt generation failed');
    });
  });

  // ─── 注册 API 校验 ──────────────────────────────────

  describe('resource/prompt 注册校验', () => {
    it('重复注册相同 uri 的 resource 抛错', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://docs/readme', { name: 'readme', read: async () => ({ contents: [] }) });
      expect(() =>
        mcp.resource('file://docs/readme', {
          name: 'readme2',
          read: async () => ({ contents: [] }),
        }),
      ).toThrow(/already registered/);
    });

    it('重复注册相同 name 的 prompt 抛错', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('greet', { get: async () => ({ messages: [] }) });
      expect(() => mcp.prompt('greet', { get: async () => ({ messages: [] }) })).toThrow(
        /already registered/,
      );
    });

    it('listResources 返回已注册 uri 列表', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://a', { name: 'a', read: async () => ({ contents: [] }) });
      mcp.resource('file://b', { name: 'b', read: async () => ({ contents: [] }) });
      expect(mcp.listResources()).toEqual(['file://a', 'file://b']);
    });

    it('listPrompts 返回已注册 name 列表', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('greet', { get: async () => ({ messages: [] }) });
      mcp.prompt('summarize', { get: async () => ({ messages: [] }) });
      expect(mcp.listPrompts()).toEqual(['greet', 'summarize']);
    });
  });

  // ─── Pagination ─────────────────────────────────────

  describe('Pagination (cursor-based)', () => {
    it('tools/list 无 cursor 返回第一页 + nextCursor', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0', defaultPageSize: 2 });
      mcp.tool('t1', { handler: async () => ({ content: [] }) });
      mcp.tool('t2', { handler: async () => ({ content: [] }) });
      mcp.tool('t3', { handler: async () => ({ content: [] }) });
      mcp.tool('t4', { handler: async () => ({ content: [] }) });

      const res = await mcp.handleJsonRpc(makeRequest(1, 'tools/list'), undefined);
      const result = (res as { result: { tools: Array<{ name: string }>; nextCursor?: string } })
        .result;
      expect(result.tools).toHaveLength(2);
      expect(result.tools[0]!.name).toBe('t1');
      expect(result.tools[1]!.name).toBe('t2');
      expect(result.nextCursor).toBeDefined();
    });

    it('tools/list 带 cursor 返回下一页', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0', defaultPageSize: 2 });
      mcp.tool('t1', { handler: async () => ({ content: [] }) });
      mcp.tool('t2', { handler: async () => ({ content: [] }) });
      mcp.tool('t3', { handler: async () => ({ content: [] }) });
      mcp.tool('t4', { handler: async () => ({ content: [] }) });

      // 第一页
      const res1 = await mcp.handleJsonRpc(makeRequest(1, 'tools/list'), undefined);
      const cursor = (res1 as { result: { nextCursor?: string } }).result.nextCursor!;

      // 第二页
      const res2 = await mcp.handleJsonRpc(makeRequest(2, 'tools/list', { cursor }), undefined);
      const result2 = (res2 as { result: { tools: Array<{ name: string }>; nextCursor?: string } })
        .result;
      expect(result2.tools).toHaveLength(2);
      expect(result2.tools[0]!.name).toBe('t3');
      expect(result2.tools[1]!.name).toBe('t4');
      expect(result2.nextCursor).toBeUndefined();
    });

    it('tools/list 数据量不足一页时不返回 nextCursor', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0', defaultPageSize: 10 });
      mcp.tool('t1', { handler: async () => ({ content: [] }) });
      mcp.tool('t2', { handler: async () => ({ content: [] }) });

      const res = await mcp.handleJsonRpc(makeRequest(1, 'tools/list'), undefined);
      const result = (res as { result: { tools: unknown[]; nextCursor?: string } }).result;
      expect(result.tools).toHaveLength(2);
      expect(result.nextCursor).toBeUndefined();
    });

    it('resources/list 支持分页', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0', defaultPageSize: 2 });
      mcp.resource('file://1', { name: 'r1', read: async () => ({ contents: [] }) });
      mcp.resource('file://2', { name: 'r2', read: async () => ({ contents: [] }) });
      mcp.resource('file://3', { name: 'r3', read: async () => ({ contents: [] }) });

      const res1 = await mcp.handleJsonRpc(makeRequest(1, 'resources/list'), undefined);
      const result1 = (
        res1 as { result: { resources: Array<{ uri: string }>; nextCursor?: string } }
      ).result;
      expect(result1.resources).toHaveLength(2);
      expect(result1.nextCursor).toBeDefined();

      const res2 = await mcp.handleJsonRpc(
        makeRequest(2, 'resources/list', { cursor: result1.nextCursor }),
        undefined,
      );
      const result2 = (
        res2 as { result: { resources: Array<{ uri: string }>; nextCursor?: string } }
      ).result;
      expect(result2.resources).toHaveLength(1);
      expect(result2.resources[0]!.uri).toBe('file://3');
      expect(result2.nextCursor).toBeUndefined();
    });

    it('prompts/list 支持分页', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0', defaultPageSize: 2 });
      mcp.prompt('p1', { get: async () => ({ messages: [] }) });
      mcp.prompt('p2', { get: async () => ({ messages: [] }) });
      mcp.prompt('p3', { get: async () => ({ messages: [] }) });

      const res1 = await mcp.handleJsonRpc(makeRequest(1, 'prompts/list'), undefined);
      const result1 = (
        res1 as { result: { prompts: Array<{ name: string }>; nextCursor?: string } }
      ).result;
      expect(result1.prompts).toHaveLength(2);
      expect(result1.nextCursor).toBeDefined();

      const res2 = await mcp.handleJsonRpc(
        makeRequest(2, 'prompts/list', { cursor: result1.nextCursor }),
        undefined,
      );
      const result2 = (
        res2 as { result: { prompts: Array<{ name: string }>; nextCursor?: string } }
      ).result;
      expect(result2.prompts).toHaveLength(1);
      expect(result2.prompts[0]!.name).toBe('p3');
    });

    it('无效 cursor 返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0', defaultPageSize: 2 });
      mcp.tool('t1', { handler: async () => ({ content: [] }) });

      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'tools/list', { cursor: '!!!invalid-base64!!!' }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      const error = (res as { error: { code: number; message: string } }).error;
      expect(error.code).toBe(-32602);
      expect(error.message).toContain('cursor');
    });

    it('cursor 超出范围返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0', defaultPageSize: 2 });
      mcp.tool('t1', { handler: async () => ({ content: [] }) });

      // 偏移量超出范围
      const cursor = Buffer.from('999').toString('base64');
      const res = await mcp.handleJsonRpc(makeRequest(1, 'tools/list', { cursor }), undefined);
      expect(isErrorResponse(res!)).toBe(true);
      const error = (res as { error: { code: number } }).error;
      expect(error.code).toBe(-32602);
    });

    it('默认每页 100 项', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      for (let i = 0; i < 101; i++) {
        mcp.tool(`t${i}`, { handler: async () => ({ content: [] }) });
      }
      const res = await mcp.handleJsonRpc(makeRequest(1, 'tools/list'), undefined);
      const result = (res as { result: { tools: unknown[]; nextCursor?: string } }).result;
      expect(result.tools).toHaveLength(100);
      expect(result.nextCursor).toBeDefined();
    });
  });

  // ─── Logging ──────────────────────────────────────────

  describe('Logging', () => {
    it('logging/setLevel 设置 session 日志级别,返回空结果', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();
      expect(session.loggingLevel).toBe('info'); // 默认 info

      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'logging/setLevel', { level: 'debug' }),
        session,
      );
      expect(isResultResponse(res!)).toBe(true);
      expect((res as { result: unknown }).result).toEqual({});
      expect(session.loggingLevel).toBe('debug');
    });

    it('logging/setLevel 支持全部 8 个级别', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();
      const levels = [
        'debug',
        'info',
        'notice',
        'warning',
        'error',
        'critical',
        'alert',
        'emergency',
      ];
      for (const level of levels) {
        const res = await mcp.handleJsonRpc(makeRequest(1, 'logging/setLevel', { level }), session);
        expect(isResultResponse(res!)).toBe(true);
        expect(session.loggingLevel).toBe(level);
      }
    });

    it('logging/setLevel 无效级别返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'logging/setLevel', { level: 'verbose' }),
        session,
      );
      expect(isErrorResponse(res!)).toBe(true);
      expect((res as { error: { code: number } }).error.code).toBe(-32602);
      // 原 level 不变
      expect(session.loggingLevel).toBe('info');
    });

    it('logging/setLevel 缺少 level 参数返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();
      const res = await mcp.handleJsonRpc(makeRequest(1, 'logging/setLevel', {}), session);
      expect(isErrorResponse(res!)).toBe(true);
      expect((res as { error: { code: number } }).error.code).toBe(-32602);
    });

    it('handler extra.sendLogging 推送 notifications/message 到 SSE 订阅者', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      // 模拟 SSE 订阅者:用 ReadableStream + controller 注册
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // 注册订阅者
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });

      // 注册 tool,handler 内调用 sendLogging
      mcp.tool('log-test', {
        handler: async (_args, { sendLogging }) => {
          sendLogging('info', { msg: 'hello' }, 'tool:log-test');
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      });

      // 读取流(异步),捕获推送数据
      const reader = stream.getReader();
      const readPromise = reader.read();

      // 触发 tool 调用,handler 内会调 sendLogging
      await mcp.handleJsonRpc(
        makeRequest(1, 'tools/call', { name: 'log-test', arguments: {} }),
        session,
      );

      // 等待 SSE 数据推送
      const { value } = await readPromise;
      expect(value).toBeDefined();
      const text = new TextDecoder().decode(value);
      expect(text).toContain('notifications/message');
      expect(text).toContain('"level":"info"');
      expect(text).toContain('"logger":"tool:log-test"');
      expect(text).toContain('"data":{"msg":"hello"}');

      await reader.cancel();
    });

    it('sendLogging 按 session.loggingLevel 过滤——低于级别的日志被丢弃', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();
      // 设置为 warning,debug 应被丢弃
      session.loggingLevel = 'warning';

      const pushed: string[] = [];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const originalEnqueue = reader.read.bind(reader);
      // 监听推送
      const readAsync = (async () => {
        // 只读一次(应为 warning 级别的日志,debug 被丢弃)
        const { value } = await originalEnqueue();
        if (value) pushed.push(new TextDecoder().decode(value));
      })();

      mcp.tool('filter-test', {
        handler: async (_args, { sendLogging }) => {
          sendLogging('debug', { msg: 'should be filtered' }); // 丢弃
          sendLogging('warning', { msg: 'should pass' }); // 通过
          return { content: [] };
        },
      });

      await mcp.handleJsonRpc(
        makeRequest(1, 'tools/call', { name: 'filter-test', arguments: {} }),
        session,
      );

      await readAsync;

      // 应只推送 warning 级别的日志(以及可能的心跳? 不,这里无心跳)
      const loggingMessages = pushed.filter((t) => t.includes('notifications/message'));
      expect(loggingMessages).toHaveLength(1);
      expect(loggingMessages[0]).toContain('"level":"warning"');
      expect(loggingMessages[0]).toContain('"should pass"');

      await reader.cancel();
    });

    it('sendLogging 无 SSE 订阅者时静默丢弃(不抛错)', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();
      // 不注册订阅者

      mcp.tool('no-sub-test', {
        handler: async (_args, { sendLogging }) => {
          // 无订阅者,应静默丢弃,不抛错
          sendLogging('info', { msg: 'no one listening' });
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      });

      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'tools/call', { name: 'no-sub-test', arguments: {} }),
        session,
      );
      expect(isResultResponse(res!)).toBe(true);
      expect(
        (res as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
      ).toBe('ok');
    });

    it('sendLogging 不带 logger 字段时 notification 不含 logger', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.tool('no-logger', {
        handler: async (_args, { sendLogging }) => {
          sendLogging('info', { msg: 'no logger field' });
          return { content: [] };
        },
      });

      await mcp.handleJsonRpc(
        makeRequest(1, 'tools/call', { name: 'no-logger', arguments: {} }),
        session,
      );

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('"level":"info"');
      expect(text).toContain('"data":{"msg":"no logger field"}');
      // 不应包含 logger 字段(可选参数未传)
      expect(text).not.toContain('"logger"');

      await reader.cancel();
    });

    it('sendLogging 通过 resource read handler extra 也可调用', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.resource('file://test', {
        name: 'test',
        read: async (_uri, { sendLogging }) => {
          sendLogging('notice', { msg: 'resource read' }, 'resource:test');
          return { contents: [{ uri: 'file://test', text: 'content' }] };
        },
      });

      await mcp.handleJsonRpc(makeRequest(1, 'resources/read', { uri: 'file://test' }), session);

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('"level":"notice"');
      expect(text).toContain('"logger":"resource:test"');

      await reader.cancel();
    });

    it('sendLogging 通过 prompt get handler extra 也可调用', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.prompt('log-prompt', {
        get: async (_args, { sendLogging }) => {
          sendLogging('error', { msg: 'prompt get' }, 'prompt:log-prompt');
          return { messages: [] };
        },
      });

      await mcp.handleJsonRpc(
        makeRequest(1, 'prompts/get', { name: 'log-prompt', arguments: {} }),
        session,
      );

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('"level":"error"');
      expect(text).toContain('"logger":"prompt:log-prompt"');

      await reader.cancel();
    });

    it('server.sendLogging 应用级 API 也可推送日志', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      // 应用级 API:外部直接调用
      mcp.sendLogging(session.id, 'info', { msg: 'app-level log' }, 'app');

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('notifications/message');
      expect(text).toContain('"level":"info"');
      expect(text).toContain('"logger":"app"');
      expect(text).toContain('"msg":"app-level log"');

      await reader.cancel();
    });

    it('server.sendLogging 无效 sessionId 静默丢弃(不抛错)', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      // 不存在的 session——应静默丢弃
      expect(() => mcp.sendLogging('nonexistent', 'info', { msg: 'x' })).not.toThrow();
    });

    it('server.sendLogging 按 session.loggingLevel 过滤', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();
      session.loggingLevel = 'error';

      const pushed: string[] = [];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();

      // 推送一条 warning(应被丢弃)和一条 error(应通过)
      mcp.sendLogging(session.id, 'warning', { msg: 'filtered' });
      mcp.sendLogging(session.id, 'error', { msg: 'pass' });

      // 读取一条(error 应通过)
      const { value } = await reader.read();
      if (value) pushed.push(new TextDecoder().decode(value));

      // 应只有 error 级别的日志
      expect(pushed).toHaveLength(1);
      expect(pushed[0]).toContain('"level":"error"');
      expect(pushed[0]).toContain('"pass"');

      await reader.cancel();
    });
  });

  // ─── Resource Subscriptions ───────────────────────────

  describe('Resource Subscriptions', () => {
    it('resources/subscribe 将 uri 加入 session.subscribedResources', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://docs/readme', {
        name: 'readme',
        read: async () => ({ contents: [] }),
      });
      const session = mcp.getSessionManager().create();

      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'resources/subscribe', { uri: 'file://docs/readme' }),
        session,
      );
      expect(isResultResponse(res!)).toBe(true);
      expect((res as { result: unknown }).result).toEqual({});
      expect(session.subscribedResources.has('file://docs/readme')).toBe(true);
    });

    it('resources/subscribe 重复订阅同一 URI 幂等', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://docs/readme', {
        name: 'readme',
        read: async () => ({ contents: [] }),
      });
      const session = mcp.getSessionManager().create();

      await mcp.handleJsonRpc(
        makeRequest(1, 'resources/subscribe', { uri: 'file://docs/readme' }),
        session,
      );
      await mcp.handleJsonRpc(
        makeRequest(2, 'resources/subscribe', { uri: 'file://docs/readme' }),
        session,
      );
      expect(session.subscribedResources.size).toBe(1);
    });

    it('resources/subscribe 缺少 uri 参数返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://docs/readme', {
        name: 'readme',
        read: async () => ({ contents: [] }),
      });
      const session = mcp.getSessionManager().create();

      const res = await mcp.handleJsonRpc(makeRequest(1, 'resources/subscribe', {}), session);
      expect(isErrorResponse(res!)).toBe(true);
      expect((res as { error: { code: number } }).error.code).toBe(-32602);
    });

    it('resources/unsubscribe 移除 URI 订阅', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://docs/readme', {
        name: 'readme',
        read: async () => ({ contents: [] }),
      });
      const session = mcp.getSessionManager().create();

      await mcp.handleJsonRpc(
        makeRequest(1, 'resources/subscribe', { uri: 'file://docs/readme' }),
        session,
      );
      expect(session.subscribedResources.has('file://docs/readme')).toBe(true);

      const res = await mcp.handleJsonRpc(
        makeRequest(2, 'resources/unsubscribe', { uri: 'file://docs/readme' }),
        session,
      );
      expect(isResultResponse(res!)).toBe(true);
      expect(session.subscribedResources.has('file://docs/readme')).toBe(false);
    });

    it('resources/unsubscribe 未订阅的 URI 也返回空结果(幂等)', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://docs/readme', {
        name: 'readme',
        read: async () => ({ contents: [] }),
      });
      const session = mcp.getSessionManager().create();

      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'resources/unsubscribe', { uri: 'file://never-subscribed' }),
        session,
      );
      expect(isResultResponse(res!)).toBe(true);
      expect((res as { result: unknown }).result).toEqual({});
    });

    it('resources/unsubscribe 缺少 uri 返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://docs/readme', {
        name: 'readme',
        read: async () => ({ contents: [] }),
      });
      const session = mcp.getSessionManager().create();

      const res = await mcp.handleJsonRpc(makeRequest(1, 'resources/unsubscribe', {}), session);
      expect(isErrorResponse(res!)).toBe(true);
      expect((res as { error: { code: number } }).error.code).toBe(-32602);
    });

    it('resources/subscribe 无 session 返回 InvalidRequest', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://docs/readme', {
        name: 'readme',
        read: async () => ({ contents: [] }),
      });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'resources/subscribe', { uri: 'file://docs/readme' }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      expect((res as { error: { code: number } }).error.code).toBe(-32600);
    });

    it('server.sendResourceUpdated 推送 notifications/resources/updated 到订阅者', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://docs/readme', {
        name: 'readme',
        read: async () => ({ contents: [] }),
      });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      // 订阅
      await mcp.handleJsonRpc(
        makeRequest(1, 'resources/subscribe', { uri: 'file://docs/readme' }),
        session,
      );

      // 推送变更
      mcp.sendResourceUpdated('file://docs/readme');

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('notifications/resources/updated');
      expect(text).toContain('"uri":"file://docs/readme"');

      await reader.cancel();
    });

    it('server.sendResourceUpdated 无订阅者时静默丢弃', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://docs/readme', {
        name: 'readme',
        read: async () => ({ contents: [] }),
      });
      // 不订阅,直接推送——应静默丢弃,不抛错
      expect(() => mcp.sendResourceUpdated('file://docs/readme')).not.toThrow();
    });

    it('server.sendResourceUpdated 只推送给订阅了该 URI 的 session', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://a', { name: 'a', read: async () => ({ contents: [] }) });
      mcp.resource('file://b', { name: 'b', read: async () => ({ contents: [] }) });

      const sessionA = mcp.getSessionManager().create();
      const sessionB = mcp.getSessionManager().create();

      // sessionA 订阅 file://a,sessionB 订阅 file://b
      await mcp.handleJsonRpc(makeRequest(1, 'resources/subscribe', { uri: 'file://a' }), sessionA);
      await mcp.handleJsonRpc(makeRequest(2, 'resources/subscribe', { uri: 'file://b' }), sessionB);

      // 注册 SSE 订阅者
      const streamA = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(sessionA.id, controller);
        },
      });
      const streamB = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(sessionB.id, controller);
        },
      });
      const readerA = streamA.getReader();
      const readerB = streamB.getReader();

      const readA = readerA.read();
      const readB = readerB.read();

      // 推送 file://a 变更——只有 sessionA 应收到
      mcp.sendResourceUpdated('file://a');

      const { value: valueA } = await readA;
      expect(new TextDecoder().decode(valueA)).toContain('"uri":"file://a"');

      // sessionB 不应收到(读取会阻塞,所以我们用 Promise.race 验证无数据)
      const raceResult = await Promise.race([
        readB.then(() => 'received'),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 50)),
      ]);
      expect(raceResult).toBe('timeout');

      await readerA.cancel();
      await readerB.cancel();
    });

    it('resources.subscribe capability 仅在注册了 resource 时声明', async () => {
      // 无 resource 注册
      const mcpNoRes = createMcpServer({ name: 'test', version: '1.0.0' });
      mcpNoRes.tool('t', { handler: async () => ({ content: [] }) });
      const resNoRes = await mcpNoRes.handleJsonRpc(makeRequest(1, 'initialize'), undefined);
      const capNoRes = (resNoRes as { result: { capabilities: Record<string, unknown> } }).result
        .capabilities;
      expect(capNoRes.resources).toBeUndefined();

      // 有 resource 注册
      const mcpWithRes = createMcpServer({ name: 'test', version: '1.0.0' });
      mcpWithRes.resource('file://x', { name: 'x', read: async () => ({ contents: [] }) });
      const resWithRes = await mcpWithRes.handleJsonRpc(makeRequest(1, 'initialize'), undefined);
      const capWithRes = (resWithRes as { result: { capabilities: Record<string, unknown> } })
        .result.capabilities;
      expect(capWithRes.resources).toEqual({ listChanged: false, subscribe: true });
    });
  });

  // ─── Resource Templates ───────────────────────────────

  describe('Resource Templates', () => {
    it('resourceTemplate 注册并 templates/list 返回', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resourceTemplate('file://docs/{path}', {
        name: 'doc',
        description: 'Document by path',
        mimeType: 'text/markdown',
        read: async () => ({ contents: [] }),
      });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'resources/templates/list'), undefined);
      expect(isResultResponse(res!)).toBe(true);
      const result = (res as { result: { resourceTemplates: Array<Record<string, unknown>> } })
        .result;
      expect(result.resourceTemplates).toHaveLength(1);
      expect(result.resourceTemplates[0]!.uriTemplate).toBe('file://docs/{path}');
      expect(result.resourceTemplates[0]!.name).toBe('doc');
      expect(result.resourceTemplates[0]!.description).toBe('Document by path');
      expect(result.resourceTemplates[0]!.mimeType).toBe('text/markdown');
    });

    it('重复注册同一 uriTemplate 抛错', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resourceTemplate('file://docs/{path}', {
        name: 'doc',
        read: async () => ({ contents: [] }),
      });
      expect(() =>
        mcp.resourceTemplate('file://docs/{path}', {
          name: 'doc2',
          read: async () => ({ contents: [] }),
        }),
      ).toThrow(/already registered/);
    });

    it('模板无 {var} 占位符抛错', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      expect(() =>
        mcp.resourceTemplate('file://docs/static', {
          name: 'static',
          read: async () => ({ contents: [] }),
        }),
      ).toThrow(/at least one/);
    });

    it('模板变量名重复抛错', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      expect(() =>
        mcp.resourceTemplate('file://docs/{path}/{path}', {
          name: 'dup',
          read: async () => ({ contents: [] }),
        }),
      ).toThrow(/Duplicate/);
    });

    it('resources/read 精确匹配优先于模板', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      // 精确 resource
      mcp.resource('file://docs/readme', {
        name: 'exact-readme',
        read: async () => ({ contents: [{ uri: 'file://docs/readme', text: 'exact' }] }),
      });
      // 模板
      mcp.resourceTemplate('file://docs/{path}', {
        name: 'tpl-doc',
        read: async () => ({ contents: [{ uri: '', text: 'template' }] }),
      });

      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'resources/read', { uri: 'file://docs/readme' }),
        undefined,
      );
      const result = (res as { result: { contents: Array<{ text: string }> } }).result;
      expect(result.contents[0]!.text).toBe('exact');
    });

    it('resources/read 模板匹配提取单变量参数', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resourceTemplate('file://docs/{path}', {
        name: 'doc',
        read: async (uri, params) => ({
          contents: [{ uri, text: `path=${params.path}` }],
        }),
      });

      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'resources/read', { uri: 'file://docs/readme' }),
        undefined,
      );
      const result = (res as { result: { contents: Array<{ text: string }> } }).result;
      expect(result.contents[0]!.text).toBe('path=readme');
    });

    it('resources/read 单变量贪婪匹配(允许 /)', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resourceTemplate('file://docs/{path}', {
        name: 'doc',
        read: async (uri, params) => ({
          contents: [{ uri, text: params.path }],
        }),
      });

      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'resources/read', { uri: 'file://docs/sub/deep/readme' }),
        undefined,
      );
      const result = (res as { result: { contents: Array<{ text: string }> } }).result;
      expect(result.contents[0]!.text).toBe('sub/deep/readme');
    });

    it('resources/read 多变量模板提取参数', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resourceTemplate('git://repo/{owner}/{repo}', {
        name: 'repo',
        read: async (uri, params) => ({
          contents: [{ uri, text: `${params.owner}/${params.repo}` }],
        }),
      });

      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'resources/read', { uri: 'git://repo/faapi/mcp' }),
        undefined,
      );
      const result = (res as { result: { contents: Array<{ text: string }> } }).result;
      expect(result.contents[0]!.text).toBe('faapi/mcp');
    });

    it('resources/read 多变量模板不匹配时返回 Unknown resource', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resourceTemplate('git://repo/{owner}/{repo}', {
        name: 'repo',
        read: async () => ({ contents: [] }),
      });

      // 只有一个路径段,不匹配 {owner}/{repo}
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'resources/read', { uri: 'git://repo/single' }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      expect((res as { error: { code: number; message: string } }).error.code).toBe(-32602);
      expect((res as { error: { message: string } }).error.message).toContain('Unknown resource');
    });

    it('resources/read 不匹配任何 resource/template 返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://exact', { name: 'e', read: async () => ({ contents: [] }) });
      mcp.resourceTemplate('file://tpl/{x}', {
        name: 't',
        read: async () => ({ contents: [] }),
      });

      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'resources/read', { uri: 'http://other' }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      expect((res as { error: { code: number } }).error.code).toBe(-32602);
    });

    it('templates/list 支持分页', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0', defaultPageSize: 2 });
      mcp.resourceTemplate('file://a/{x}', { name: 'a', read: async () => ({ contents: [] }) });
      mcp.resourceTemplate('file://b/{x}', { name: 'b', read: async () => ({ contents: [] }) });
      mcp.resourceTemplate('file://c/{x}', { name: 'c', read: async () => ({ contents: [] }) });

      const res1 = await mcp.handleJsonRpc(makeRequest(1, 'resources/templates/list'), undefined);
      const result1 = (res1 as { result: { resourceTemplates: unknown[]; nextCursor?: string } })
        .result;
      expect(result1.resourceTemplates).toHaveLength(2);
      expect(result1.nextCursor).toBeDefined();

      const res2 = await mcp.handleJsonRpc(
        makeRequest(2, 'resources/templates/list', { cursor: result1.nextCursor }),
        undefined,
      );
      const result2 = (res2 as { result: { resourceTemplates: unknown[]; nextCursor?: string } })
        .result;
      expect(result2.resourceTemplates).toHaveLength(1);
      expect(result2.nextCursor).toBeUndefined();
    });

    it('templates/list 无模板时返回空列表', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'resources/templates/list'), undefined);
      const result = (res as { result: { resourceTemplates: unknown[] } }).result;
      expect(result.resourceTemplates).toEqual([]);
    });

    it('resource template read handler 接收 sendLogging extra', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.resourceTemplate('file://logs/{name}', {
        name: 'log',
        read: async (_uri, params, { sendLogging }) => {
          sendLogging('info', { msg: `reading ${params.name}` }, 'template:log');
          return { contents: [] };
        },
      });

      await mcp.handleJsonRpc(
        makeRequest(1, 'resources/read', { uri: 'file://logs/app' }),
        session,
      );

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('notifications/message');
      expect(text).toContain('"logger":"template:log"');

      await reader.cancel();
    });

    it('注册 resource template 时声明 resources.subscribe capability', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resourceTemplate('file://docs/{path}', {
        name: 'doc',
        read: async () => ({ contents: [] }),
      });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'initialize'), undefined);
      const result = (res as { result: { capabilities: { resources?: Record<string, unknown> } } })
        .result;
      expect(result.capabilities.resources).toEqual({ listChanged: false, subscribe: true });
    });
  });

  // ─── Progress Notifications ───────────────────────────

  describe('Progress Notifications', () => {
    it('handler extra.sendProgress 推送 notifications/progress 到 SSE 订阅者', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.tool('long-task', {
        handler: async (_args, { sendProgress }) => {
          sendProgress(50, 100);
          return { content: [{ type: 'text', text: 'done' }] };
        },
      });

      // 客户端在 _meta.progressToken 传入 token
      await mcp.handleJsonRpc(
        makeRequest(1, 'tools/call', {
          name: 'long-task',
          arguments: {},
          _meta: { progressToken: 'task-123' },
        }),
        session,
      );

      const { value } = await readPromise;
      expect(value).toBeDefined();
      const text = new TextDecoder().decode(value);
      expect(text).toContain('notifications/progress');
      expect(text).toContain('"progressToken":"task-123"');
      expect(text).toContain('"progress":50');
      expect(text).toContain('"total":100');

      await reader.cancel();
    });

    it('progressToken 为数字时正常推送', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.tool('num-token', {
        handler: async (_args, { sendProgress }) => {
          sendProgress(1);
          return { content: [] };
        },
      });

      await mcp.handleJsonRpc(
        makeRequest(1, 'tools/call', {
          name: 'num-token',
          arguments: {},
          _meta: { progressToken: 42 },
        }),
        session,
      );

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('"progressToken":42');
      expect(text).toContain('"progress":1');
      // 不传 total 时 notification 不含 total 字段
      expect(text).not.toContain('"total"');

      await reader.cancel();
    });

    it('请求未携带 _meta.progressToken 时 sendProgress 静默丢弃', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();
      // 设置超时保护:无推送时 readPromise 不会 resolve
      const timeoutPromise = new Promise<{ timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), 50),
      );

      mcp.tool('no-token', {
        handler: async (_args, { sendProgress }) => {
          sendProgress(50, 100); // 无 progressToken,应静默丢弃
          return { content: [] };
        },
      });

      await mcp.handleJsonRpc(
        makeRequest(1, 'tools/call', { name: 'no-token', arguments: {} }),
        session,
      );

      // 等待推送或超时
      const result = await Promise.race([readPromise, timeoutPromise]);
      // 超时 → 无推送(符合预期)；非超时 → 有推送(不应发生)
      const pushed = !('timedOut' in result);
      expect(pushed).toBe(false);

      await reader.cancel();
    });

    it('sendProgress 无 SSE 订阅者时静默丢弃(不抛错)', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();
      // 不注册订阅者

      mcp.tool('no-sub', {
        handler: async (_args, { sendProgress }) => {
          // 无订阅者,应静默丢弃,不抛错
          sendProgress(50, 100);
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      });

      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'tools/call', {
          name: 'no-sub',
          arguments: {},
          _meta: { progressToken: 'no-sub-token' },
        }),
        session,
      );
      expect(isResultResponse(res!)).toBe(true);
      expect(
        (res as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
      ).toBe('ok');
    });

    it('sendProgress 通过 resource read handler extra 也可调用', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.resource('file://big', {
        name: 'big',
        read: async (_uri, { sendProgress }) => {
          sendProgress(30, 100);
          return { contents: [{ uri: 'file://big', text: 'partial' }] };
        },
      });

      await mcp.handleJsonRpc(
        makeRequest(1, 'resources/read', {
          uri: 'file://big',
          _meta: { progressToken: 'res-progress' },
        }),
        session,
      );

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('notifications/progress');
      expect(text).toContain('"progressToken":"res-progress"');
      expect(text).toContain('"progress":30');

      await reader.cancel();
    });

    it('sendProgress 通过 prompt get handler extra 也可调用', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.prompt('gen-prompt', {
        get: async (_args, { sendProgress }) => {
          sendProgress(80, 100);
          return { messages: [] };
        },
      });

      await mcp.handleJsonRpc(
        makeRequest(1, 'prompts/get', {
          name: 'gen-prompt',
          arguments: {},
          _meta: { progressToken: 'prompt-progress' },
        }),
        session,
      );

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('"progressToken":"prompt-progress"');
      expect(text).toContain('"progress":80');

      await reader.cancel();
    });

    it('sendProgress 通过 resource template read handler extra 也可调用', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.resourceTemplate('file://docs/{path}', {
        name: 'doc',
        read: async (_uri, _params, { sendProgress }) => {
          sendProgress(50, 100);
          return { contents: [] };
        },
      });

      await mcp.handleJsonRpc(
        makeRequest(1, 'resources/read', {
          uri: 'file://docs/readme',
          _meta: { progressToken: 'tpl-progress' },
        }),
        session,
      );

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('"progressToken":"tpl-progress"');
      expect(text).toContain('"progress":50');

      await reader.cancel();
    });

    it('server.sendProgress 应用级 API 也可推送进度', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      // 应用级 API:外部直接调用
      mcp.sendProgress(session.id, 'app-token', 75, 200);

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('notifications/progress');
      expect(text).toContain('"progressToken":"app-token"');
      expect(text).toContain('"progress":75');
      expect(text).toContain('"total":200');

      await reader.cancel();
    });

    it('server.sendProgress 无效 sessionId 静默丢弃(不抛错)', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      // 不存在的 session——应静默丢弃
      expect(() => mcp.sendProgress('nonexistent', 'token', 50, 100)).not.toThrow();
    });

    it('server.sendProgress progressToken 为 null/undefined 静默丢弃', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();

      // null/undefined token 都应静默丢弃,不抛错、不推送
      expect(() => mcp.sendProgress(session.id, undefined, 50, 100)).not.toThrow();
      expect(() => mcp.sendProgress(session.id, null, 50, 100)).not.toThrow();

      // 关闭流,避免泄漏
      reader.cancel();
    });
  });

  // ─── Completion ──────────────────────────────────────

  describe('Completion', () => {
    it('completion/complete 调用 prompt 参数补全 handler', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('greet', {
        arguments: [{ name: 'userName', required: true }],
        get: async () => ({ messages: [] }),
      });
      mcp.completion({ type: 'ref/prompt', name: 'greet' }, 'userName', async (value) => ({
        values: ['Alice', 'Bob', 'Andy'].filter((n) => n.startsWith(value)),
        total: 3,
        hasMore: false,
      }));

      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'completion/complete', {
          ref: { type: 'ref/prompt', name: 'greet' },
          argument: { name: 'userName', value: 'A' },
        }),
        undefined,
      );
      expect(isResultResponse(res!)).toBe(true);
      const result = (
        res as { result: { completion: { values: string[]; total?: number; hasMore?: boolean } } }
      ).result;
      expect(result.completion.values).toEqual(['Alice', 'Andy']);
      expect(result.completion.total).toBe(3);
      expect(result.completion.hasMore).toBe(false);
    });

    it('completion/complete 调用 resource template 参数补全 handler', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resourceTemplate('file://docs/{path}', {
        name: 'doc',
        read: async () => ({ contents: [] }),
      });
      mcp.completion(
        { type: 'ref/resource', uri: 'file://docs/{path}' },
        'path',
        async (value) => ({
          values: ['readme', 'guide', 'api'].filter((p) => p.startsWith(value)),
        }),
      );

      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'completion/complete', {
          ref: { type: 'ref/resource', uri: 'file://docs/{path}' },
          argument: { name: 'path', value: 'r' },
        }),
        undefined,
      );
      expect(isResultResponse(res!)).toBe(true);
      const result = (res as { result: { completion: { values: string[] } } }).result;
      expect(result.completion.values).toEqual(['readme']);
    });

    it('completion/complete 传递 context.arguments(其他已填参数)', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('greet', {
        arguments: [{ name: 'language' }, { name: 'userName' }],
        get: async () => ({ messages: [] }),
      });
      let receivedArgs: Record<string, string> | undefined;
      mcp.completion({ type: 'ref/prompt', name: 'greet' }, 'userName', async (value, ctx) => {
        receivedArgs = ctx.arguments;
        return { values: [`${value}-${ctx.arguments.language}`] };
      });

      await mcp.handleJsonRpc(
        makeRequest(1, 'completion/complete', {
          ref: { type: 'ref/prompt', name: 'greet' },
          argument: { name: 'userName', value: 'A' },
          arguments: { language: 'en' },
        }),
        undefined,
      );
      expect(receivedArgs).toEqual({ language: 'en' });
    });

    it('未携带 arguments 时 context.arguments 为空对象', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('greet', {
        arguments: [{ name: 'userName' }],
        get: async () => ({ messages: [] }),
      });
      let receivedArgs: Record<string, string> | undefined;
      mcp.completion({ type: 'ref/prompt', name: 'greet' }, 'userName', async (_value, ctx) => {
        receivedArgs = ctx.arguments;
        return { values: [] };
      });

      await mcp.handleJsonRpc(
        makeRequest(1, 'completion/complete', {
          ref: { type: 'ref/prompt', name: 'greet' },
          argument: { name: 'userName', value: 'A' },
        }),
        undefined,
      );
      expect(receivedArgs).toEqual({});
    });

    it('argument.value 缺失时传空字符串给 handler', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('greet', {
        arguments: [{ name: 'userName' }],
        get: async () => ({ messages: [] }),
      });
      let receivedValue: string | undefined;
      mcp.completion({ type: 'ref/prompt', name: 'greet' }, 'userName', async (value) => {
        receivedValue = value;
        return { values: ['Alice', 'Bob'] };
      });

      await mcp.handleJsonRpc(
        makeRequest(1, 'completion/complete', {
          ref: { type: 'ref/prompt', name: 'greet' },
          argument: { name: 'userName' }, // 无 value
        }),
        undefined,
      );
      expect(receivedValue).toBe('');
    });

    it('未注册 handler 返回 MethodNotFound', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'completion/complete', {
          ref: { type: 'ref/prompt', name: 'unknown' },
          argument: { name: 'userName', value: 'A' },
        }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      const error = (res as { error: { code: number; message: string } }).error;
      expect(error.code).toBe(-32601);
      expect(error.message).toContain('No completion handler');
    });

    it('无效 ref.type 返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'completion/complete', {
          ref: { type: 'ref/unknown', name: 'foo' },
          argument: { name: 'userName', value: 'A' },
        }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      expect((res as { error: { code: number } }).error.code).toBe(-32602);
    });

    it('ref 缺失 name/uri 返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'completion/complete', {
          ref: { type: 'ref/prompt' }, // 缺 name
          argument: { name: 'userName', value: 'A' },
        }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      expect((res as { error: { code: number } }).error.code).toBe(-32602);
    });

    it('argument 缺失 name 返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('greet', {
        arguments: [{ name: 'userName' }],
        get: async () => ({ messages: [] }),
      });
      mcp.completion({ type: 'ref/prompt', name: 'greet' }, 'userName', async () => ({
        values: [],
      }));
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'completion/complete', {
          ref: { type: 'ref/prompt', name: 'greet' },
          argument: { value: 'A' }, // 缺 name
        }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      expect((res as { error: { code: number } }).error.code).toBe(-32602);
    });

    it('缺 ref 或 argument 参数返回 InvalidParams', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'completion/complete', {}), // 缺 ref 和 argument
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      expect((res as { error: { code: number } }).error.code).toBe(-32602);
    });

    it('handler 抛错返回 InternalError', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('greet', {
        arguments: [{ name: 'userName' }],
        get: async () => ({ messages: [] }),
      });
      mcp.completion({ type: 'ref/prompt', name: 'greet' }, 'userName', async () => {
        throw new Error('db unavailable');
      });
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'completion/complete', {
          ref: { type: 'ref/prompt', name: 'greet' },
          argument: { name: 'userName', value: 'A' },
        }),
        undefined,
      );
      expect(isErrorResponse(res!)).toBe(true);
      const error = (res as { error: { code: number; message: string } }).error;
      expect(error.code).toBe(-32603);
      expect(error.message).toContain('db unavailable');
    });

    it('重复注册同一 (ref, argumentName) 抛错', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('greet', {
        arguments: [{ name: 'userName' }],
        get: async () => ({ messages: [] }),
      });
      mcp.completion({ type: 'ref/prompt', name: 'greet' }, 'userName', async () => ({
        values: [],
      }));
      expect(() =>
        mcp.completion({ type: 'ref/prompt', name: 'greet' }, 'userName', async () => ({
          values: [],
        })),
      ).toThrow(/already registered/);
    });

    it('同一 prompt 不同 argumentName 可分别注册', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('greet', {
        arguments: [{ name: 'language' }, { name: 'userName' }],
        get: async () => ({ messages: [] }),
      });
      mcp.completion({ type: 'ref/prompt', name: 'greet' }, 'language', async () => ({
        values: ['en', 'zh'],
      }));
      mcp.completion({ type: 'ref/prompt', name: 'greet' }, 'userName', async () => ({
        values: ['Alice'],
      }));

      const res1 = await mcp.handleJsonRpc(
        makeRequest(1, 'completion/complete', {
          ref: { type: 'ref/prompt', name: 'greet' },
          argument: { name: 'language', value: '' },
        }),
        undefined,
      );
      const res2 = await mcp.handleJsonRpc(
        makeRequest(2, 'completion/complete', {
          ref: { type: 'ref/prompt', name: 'greet' },
          argument: { name: 'userName', value: 'A' },
        }),
        undefined,
      );
      expect(
        (res1 as { result: { completion: { values: string[] } } }).result.completion.values,
      ).toEqual(['en', 'zh']);
      expect(
        (res2 as { result: { completion: { values: string[] } } }).result.completion.values,
      ).toEqual(['Alice']);
    });
  });

  // ─── 业务拓展:自定义方法 ─────────────────────────────

  describe('Custom Methods', () => {
    it('注册并调用自定义方法', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.method('myapp/health', async () => ({ status: 'ok' }));

      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'myapp/health', { foo: 'bar' }),
        undefined,
      );
      expect(isResultResponse(res!)).toBe(true);
      const result = (res as { result: { status: string } }).result;
      expect(result.status).toBe('ok');
    });

    it('自定义方法接收 params', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      let receivedParams: unknown;
      mcp.method('myapp/echo', async (params) => {
        receivedParams = params;
        return { echoed: params };
      });

      await mcp.handleJsonRpc(makeRequest(1, 'myapp/echo', { msg: 'hello' }), undefined);
      expect(receivedParams).toEqual({ msg: 'hello' });
    });

    it('自定义方法接收 session', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      let receivedSession;
      mcp.method('myapp/whoami', async (_params, session) => {
        receivedSession = session;
        return { id: session?.id ?? 'anonymous' };
      });

      const session = mcp.getSessionManager().create();
      await mcp.handleJsonRpc(makeRequest(1, 'myapp/whoami'), session);
      expect(receivedSession).toBe(session);
    });

    it('自定义方法 extra 含 sessionId/sendLogging/sendProgress', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.method('myapp/log-test', async (_params, _session, extra) => {
        expect(extra.sessionId).toBe(session.id);
        expect(typeof extra.sendLogging).toBe('function');
        expect(typeof extra.sendProgress).toBe('function');
        extra.sendLogging('info', { msg: 'from custom method' }, 'myapp');
        return { ok: true };
      });

      await mcp.handleJsonRpc(makeRequest(1, 'myapp/log-test'), session);

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('notifications/message');
      expect(text).toContain('"logger":"myapp"');

      await reader.cancel();
    });

    it('自定义方法返回 JsonRpcErrorResponse 作为错误响应', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.method('myapp/fail', async () => ({
        jsonrpc: '2.0' as const,
        id: null,
        error: { code: -32001, message: 'business error', data: { reason: 'x' } },
      }));

      const res = await mcp.handleJsonRpc(makeRequest(1, 'myapp/fail'), undefined);
      expect(isErrorResponse(res!)).toBe(true);
      const error = (res as { error: { code: number; message: string; data?: unknown } }).error;
      expect(error.code).toBe(-32001);
      expect(error.message).toBe('business error');
      expect(error.data).toEqual({ reason: 'x' });
      // id 应被替换为请求 id
      expect((res as { id: number }).id).toBe(1);
    });

    it('自定义方法抛错返回 InternalError', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.method('myapp/throw', async () => {
        throw new Error('boom');
      });

      const res = await mcp.handleJsonRpc(makeRequest(1, 'myapp/throw'), undefined);
      expect(isErrorResponse(res!)).toBe(true);
      expect((res as { error: { code: number; message: string } }).error.code).toBe(-32603);
      expect((res as { error: { message: string } }).error.message).toContain('boom');
    });

    it('注册内置方法抛错', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      expect(() => mcp.method('initialize', async () => ({}))).toThrow(/reserved by MCP protocol/);
      expect(() => mcp.method('tools/list', async () => ({}))).toThrow(/reserved by MCP protocol/);
      expect(() => mcp.method('ping', async () => ({}))).toThrow(/reserved by MCP protocol/);
      expect(() => mcp.method('completion/complete', async () => ({}))).toThrow(
        /reserved by MCP protocol/,
      );
    });

    it('重复注册同名方法抛错', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.method('myapp/x', async () => ({}));
      expect(() => mcp.method('myapp/x', async () => ({}))).toThrow(/already registered/);
    });

    it('未注册方法返回 MethodNotFound', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'myapp/unknown'), undefined);
      expect(isErrorResponse(res!)).toBe(true);
      expect((res as { error: { code: number } }).error.code).toBe(-32601);
    });

    it('listMethods 列出已注册自定义方法', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.method('myapp/a', async () => ({}));
      mcp.method('myapp/b', async () => ({}));
      expect(mcp.listMethods().sort()).toEqual(['myapp/a', 'myapp/b']);
    });

    it('removeMethod 删除自定义方法', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.method('myapp/temp', async () => ({ ok: true }));
      expect(mcp.removeMethod('myapp/temp')).toBe(true);
      expect(mcp.listMethods()).toEqual([]);
      // 删除后调用返回 MethodNotFound
      const res = await mcp.handleJsonRpc(makeRequest(1, 'myapp/temp'), undefined);
      expect(isErrorResponse(res!)).toBe(true);
      expect((res as { error: { code: number } }).error.code).toBe(-32601);
    });

    it('removeMethod 删除不存在的方法返回 false', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      expect(mcp.removeMethod('nonexistent')).toBe(false);
    });
  });

  // ─── 业务拓展:remove 与 listChanged 通知 ─────────────

  describe('Remove & listChanged', () => {
    it('removeTool 删除 tool', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.tool('temp', { handler: async () => ({ content: [] }) });
      expect(mcp.removeTool('temp')).toBe(true);
      expect(mcp.listTools()).toEqual([]);
    });

    it('removeTool 删除不存在的 tool 返回 false', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      expect(mcp.removeTool('nonexistent')).toBe(false);
    });

    it('removeResource 删除 resource', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resource('file://temp', { name: 'temp', read: async () => ({ contents: [] }) });
      expect(mcp.removeResource('file://temp')).toBe(true);
      expect(mcp.listResources()).toEqual([]);
    });

    it('removeResourceTemplate 删除 resource template', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.resourceTemplate('file://docs/{path}', {
        name: 'doc',
        read: async () => ({ contents: [] }),
      });
      expect(mcp.removeResourceTemplate('file://docs/{path}')).toBe(true);
    });

    it('removePrompt 删除 prompt', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('temp', { get: async () => ({ messages: [] }) });
      expect(mcp.removePrompt('temp')).toBe(true);
      expect(mcp.listPrompts()).toEqual([]);
    });

    it('removeCompletion 删除 completion handler', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      mcp.prompt('greet', {
        arguments: [{ name: 'userName' }],
        get: async () => ({ messages: [] }),
      });
      mcp.completion({ type: 'ref/prompt', name: 'greet' }, 'userName', async () => ({
        values: ['Alice'],
      }));
      expect(mcp.removeCompletion({ type: 'ref/prompt', name: 'greet' }, 'userName')).toBe(true);
      // 删除后调用返回 MethodNotFound
      const res = await mcp.handleJsonRpc(
        makeRequest(1, 'completion/complete', {
          ref: { type: 'ref/prompt', name: 'greet' },
          argument: { name: 'userName', value: 'A' },
        }),
        undefined,
      );
      expect((res as { error: { code: number } }).error.code).toBe(-32601);
    });

    it('toolsListChanged: true 时 initialize 声明 listChanged: true', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0', toolsListChanged: true });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'initialize'), undefined);
      const result = (res as { result: { capabilities: { tools: { listChanged: boolean } } } })
        .result;
      expect(result.capabilities.tools.listChanged).toBe(true);
    });

    it('resourcesListChanged: true 时 initialize 声明 listChanged: true', async () => {
      const mcp = createMcpServer({
        name: 'test',
        version: '1.0.0',
        resourcesListChanged: true,
      });
      mcp.resource('file://temp', { name: 'temp', read: async () => ({ contents: [] }) });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'initialize'), undefined);
      const result = (res as { result: { capabilities: { resources: { listChanged: boolean } } } })
        .result;
      expect(result.capabilities.resources.listChanged).toBe(true);
    });

    it('promptsListChanged: true 时 initialize 声明 listChanged: true', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0', promptsListChanged: true });
      mcp.prompt('temp', { get: async () => ({ messages: [] }) });
      const res = await mcp.handleJsonRpc(makeRequest(1, 'initialize'), undefined);
      const result = (res as { result: { capabilities: { prompts: { listChanged: boolean } } } })
        .result;
      expect(result.capabilities.prompts.listChanged).toBe(true);
    });

    it('toolsListChanged: true 时 removeTool 推送 notifications/tools/list_changed', async () => {
      const mcp = createMcpServer({
        name: 'test',
        version: '1.0.0',
        toolsListChanged: true,
      });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.tool('temp', { handler: async () => ({ content: [] }) });
      mcp.removeTool('temp'); // 应自动推送 list_changed

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('notifications/tools/list_changed');

      await reader.cancel();
    });

    it('toolsListChanged: false 时 removeTool 不推送通知', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' }); // 默认 false
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();
      const timeoutPromise = new Promise<{ timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), 50),
      );

      mcp.tool('temp', { handler: async () => ({ content: [] }) });
      mcp.removeTool('temp'); // listChanged: false,不应推送

      const result = await Promise.race([readPromise, timeoutPromise]);
      const pushed = !('timedOut' in result);
      expect(pushed).toBe(false);

      await reader.cancel();
    });

    it('resourcesListChanged: true 时 removeResource 推送 notifications/resources/list_changed', async () => {
      const mcp = createMcpServer({
        name: 'test',
        version: '1.0.0',
        resourcesListChanged: true,
      });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.resource('file://temp', { name: 'temp', read: async () => ({ contents: [] }) });
      mcp.removeResource('file://temp');

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('notifications/resources/list_changed');

      await reader.cancel();
    });

    it('promptsListChanged: true 时 removePrompt 推送 notifications/prompts/list_changed', async () => {
      const mcp = createMcpServer({
        name: 'test',
        version: '1.0.0',
        promptsListChanged: true,
      });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.prompt('temp', { get: async () => ({ messages: [] }) });
      mcp.removePrompt('temp');

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('notifications/prompts/list_changed');

      await reader.cancel();
    });

    it('notifyToolsListChanged 广播到所有 session', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session1 = mcp.getSessionManager().create();
      const session2 = mcp.getSessionManager().create();

      let pushed1 = false;
      let pushed2 = false;
      const stream1 = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session1.id, controller);
        },
      });
      const stream2 = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session2.id, controller);
        },
      });
      const reader1 = stream1.getReader();
      const reader2 = stream2.getReader();
      const p1 = reader1.read().then(({ value }) => {
        if (value)
          pushed1 = new TextDecoder().decode(value).includes('notifications/tools/list_changed');
      });
      const p2 = reader2.read().then(({ value }) => {
        if (value)
          pushed2 = new TextDecoder().decode(value).includes('notifications/tools/list_changed');
      });

      mcp.notifyToolsListChanged();
      await Promise.all([p1, p2]);
      expect(pushed1).toBe(true);
      expect(pushed2).toBe(true);

      await reader1.cancel();
      await reader2.cancel();
    });

    it('notifyToolsListChanged 无订阅者时静默(不抛错)', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      // 无 session、无订阅者
      expect(() => mcp.notifyToolsListChanged()).not.toThrow();
    });
  });

  // ─── 业务拓展:通用通知推送 ───────────────────────────

  describe('sendNotification (generic)', () => {
    it('推送自定义通知到 session 的 SSE 订阅者', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.sendNotification(session.id, 'notifications/myapp/sync', { event: 'data-updated' });

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('notifications/myapp/sync');
      expect(text).toContain('"event":"data-updated"');

      await reader.cancel();
    });

    it('sendNotification 不传 params 时 notification 不含 params', async () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mcp.getSessionManager().addSubscriber(session.id, controller);
        },
      });
      const reader = stream.getReader();
      const readPromise = reader.read();

      mcp.sendNotification(session.id, 'notifications/myapp/simple');

      const { value } = await readPromise;
      const text = new TextDecoder().decode(value);
      expect(text).toContain('"method":"notifications/myapp/simple"');
      // 不应包含 params 字段
      expect(text).not.toContain('"params"');

      await reader.cancel();
    });

    it('sendNotification 无效 sessionId 静默丢弃(不抛错)', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      expect(() => mcp.sendNotification('nonexistent', 'notifications/x')).not.toThrow();
    });

    it('sendNotification 无订阅者时静默丢弃(不抛错)', () => {
      const mcp = createMcpServer({ name: 'test', version: '1.0.0' });
      const session = mcp.getSessionManager().create();
      // session 存在但无订阅者
      expect(() => mcp.sendNotification(session.id, 'notifications/x')).not.toThrow();
    });
  });
});
