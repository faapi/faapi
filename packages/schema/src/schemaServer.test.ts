import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleMcpRequest, type McpServer } from '@faapi/mcp';
import { createSchemaServer } from './schemaServer';
import { invalidateProgramCache } from '@faapi/faapi';
import type { RouteManifest } from '@faapi/faapi';

/**
 * Schema Server MCP resources 测试
 *
 * 验证 resource-centric 改造:
 * - 静态 resource(每个路由一个)
 * - resourceTemplate(按方法过滤)
 * - completion(method 参数补全)
 * - resources/subscribe / unsubscribe
 * - capability 协商(resources + listChanged + subscribe)
 */
describe('schemaServer MCP resources', () => {
  let tempDir: string;

  beforeEach(() => {
    invalidateProgramCache();
    tempDir = join(
      tmpdir(),
      `faapi-mcp-res-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });

    mkdirSync(join(tempDir, 'api/user'), { recursive: true });
    writeFileSync(
      join(tempDir, 'api/user/handler.ts'),
      `export interface GETQuery { page: number; pageSize: number; }
export interface POSTBody { name: string; email: string; }
export function GET(query: GETQuery) { return query; }
export function POST(body: POSTBody) { return body; }\n`,
      'utf-8',
    );
  });

  afterEach(() => {
    invalidateProgramCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const routes: RouteManifest = [
    {
      method: 'GET',
      urlPath: '/api/user',
      filePath: 'api/user/handler.ts',
      paramNames: [],
      isDynamic: false,
    },
    {
      method: 'POST',
      urlPath: '/api/user',
      filePath: 'api/user/handler.ts',
      paramNames: [],
      isDynamic: false,
    },
  ];

  function createServer(): McpServer {
    return createSchemaServer(() => routes, tempDir);
  }

  /** 发送 MCP POST 请求 */
  async function sendMcpPost(
    mcp: McpServer,
    body: unknown,
    sessionId?: string,
  ): Promise<{ status: number; json: any; sessionId?: string }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const response = await handleMcpRequest(request, mcp);
    const json = await response.json();
    return {
      status: response.status,
      json,
      sessionId: response.headers.get('mcp-session-id') ?? undefined,
    };
  }

  /** 初始化握手 */
  async function initialize(mcp: McpServer): Promise<string> {
    const { json, sessionId } = await sendMcpPost(mcp, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'test-client', version: '0.0.1' },
        capabilities: {},
      },
    });
    expect(json.result).toBeDefined();
    return sessionId!;
  }

  // ─── capability 协商 ───────────────────────────────────

  it('serverInfo.version 与 package.json 同步（不硬编码）', async () => {
    const mcp = createServer();
    const { json } = await sendMcpPost(mcp, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });

    expect(json.result.serverInfo.name).toBe('faapi-schema');
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };

    expect(json.result.serverInfo.version).toBe(pkg.version);
    expect(json.result.serverInfo.version).not.toBe('0.0.1'); // 防止回退到硬编码
  });

  it('initialize 声明 resources capability(listChanged: true + subscribe: true)', async () => {
    const mcp = createServer();
    const { json } = await sendMcpPost(mcp, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    const caps = json.result.capabilities;
    expect(caps.resources).toBeDefined();
    expect(caps.resources.listChanged).toBe(true);
    expect(caps.resources.subscribe).toBe(true);
  });

  // ─── resources/list ────────────────────────────────────

  it('resources/list 返回每个路由一个静态 resource(不含 template)', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    const { json } = await sendMcpPost(
      mcp,
      { jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} },
      sid,
    );

    expect(json.result).toBeDefined();
    const resources = json.result.resources;
    // 2 个静态 resource(template 通过 resources/templates/list 单独列出)
    expect(resources).toHaveLength(2);

    const uris = resources.map((r: any) => r.uri).sort();
    expect(uris).toEqual(['faapi://route/GET/api/user', 'faapi://route/POST/api/user']);

    // 校验字段
    const getRes = resources.find((r: any) => r.uri === 'faapi://route/GET/api/user');
    expect(getRes.name).toBe('GET /api/user');
    expect(getRes.mimeType).toBe('application/json');
  });

  it('resources/templates/list 返回 by-method 模板', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    const { json } = await sendMcpPost(
      mcp,
      { jsonrpc: '2.0', id: 2, method: 'resources/templates/list', params: {} },
      sid,
    );

    expect(json.result).toBeDefined();
    const templates = json.result.resourceTemplates;
    expect(templates).toHaveLength(1);
    expect(templates[0].uriTemplate).toBe('faapi://routes/by-method/{method}');
    expect(templates[0].name).toBe('routes-by-method');
  });

  // ─── resources/read 静态 resource ──────────────────────

  it('resources/read 静态 resource 返回路由完整 schema(含 output 响应类型)', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    const { json } = await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'faapi://route/GET/api/user' },
      },
      sid,
    );

    expect(json.result).toBeDefined();
    const content = json.result.contents[0];
    expect(content.uri).toBe('faapi://route/GET/api/user');
    expect(content.mimeType).toBe('application/json');

    const schema = JSON.parse(content.text);
    expect(schema.method).toBe('GET');
    expect(schema.path).toBe('/api/user');
    expect(schema.inputs[0].source).toBe('query');
    expect(schema.inputs[0].schemaName).toBe('GETQuery');
    // output 字段存在(handler 无显式返回类型注解 → null)
    expect(schema.output).toBeNull();
  });

  it('resources/read 未知 URI 返回 InvalidParams', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    const { json } = await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'faapi://route/GET/nonexistent' },
      },
      sid,
    );

    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32602); // InvalidParams
  });

  it('resources/read 缺 uri 参数返回 InvalidParams', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    const { json } = await sendMcpPost(
      mcp,
      { jsonrpc: '2.0', id: 2, method: 'resources/read', params: {} },
      sid,
    );

    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32602);
  });

  // ─── resources/read template ───────────────────────────

  it('resources/read template 返回该方法的所有路由', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    const { json } = await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'faapi://routes/by-method/GET' },
      },
      sid,
    );

    expect(json.result).toBeDefined();
    const content = json.result.contents[0];
    expect(content.uri).toBe('faapi://routes/by-method/GET');

    const list = JSON.parse(content.text);
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0].method).toBe('GET');
    expect(list[0].path).toBe('/api/user');
  });

  it('resources/read template POST 返回 POST 路由', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    const { json } = await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'faapi://routes/by-method/POST' },
      },
      sid,
    );

    const list = JSON.parse(json.result.contents[0].text);
    expect(list).toHaveLength(1);
    expect(list[0].method).toBe('POST');
  });

  it('resources/read template method 不合法返回空数组(无匹配路由)', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    const { json } = await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'faapi://routes/by-method/INVALID' },
      },
      sid,
    );

    expect(json.result).toBeDefined();
    const list = JSON.parse(json.result.contents[0].text);
    expect(list).toEqual([]);
  });

  // ─── resources/subscribe / unsubscribe ─────────────────

  it('resources/subscribe 返回空结果(幂等)', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    const { json: sub1 } = await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/subscribe',
        params: { uri: 'faapi://route/GET/api/user' },
      },
      sid,
    );
    expect(sub1.result).toEqual({});

    // 重复订阅幂等
    const { json: sub2 } = await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/subscribe',
        params: { uri: 'faapi://route/GET/api/user' },
      },
      sid,
    );
    expect(sub2.result).toEqual({});
  });

  it('resources/unsubscribe 返回空结果(幂等)', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/subscribe',
        params: { uri: 'faapi://route/GET/api/user' },
      },
      sid,
    );

    const { json } = await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/unsubscribe',
        params: { uri: 'faapi://route/GET/api/user' },
      },
      sid,
    );
    expect(json.result).toEqual({});

    // 未订阅的 URI 取消订阅也返回 {}
    const { json: json2 } = await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'resources/unsubscribe',
        params: { uri: 'faapi://route/POST/api/user' },
      },
      sid,
    );
    expect(json2.result).toEqual({});
  });

  // ─── completion/complete ───────────────────────────────

  it('completion/complete 为 method 参数返回 HTTP 方法候选值', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    const { json } = await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/resource', uri: 'faapi://routes/by-method/{method}' },
          argument: { name: 'method', value: 'G' },
        },
      },
      sid,
    );

    expect(json.result).toBeDefined();
    expect(json.result.completion.values).toContain('GET');
    // 不含 POST(因为 POST 不以 G 开头)
    expect(json.result.completion.values).not.toContain('POST');
  });

  it('completion/complete 空值返回所有方法', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    const { json } = await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/resource', uri: 'faapi://routes/by-method/{method}' },
          argument: { name: 'method', value: '' },
        },
      },
      sid,
    );

    const values = json.result.completion.values;
    expect(values).toContain('GET');
    expect(values).toContain('POST');
    expect(values).toContain('PUT');
    expect(values).toContain('DELETE');
  });

  it('completion/complete 大小写不敏感(P → POST)', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    const { json } = await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/resource', uri: 'faapi://routes/by-method/{method}' },
          argument: { name: 'method', value: 'p' },
        },
      },
      sid,
    );

    const values = json.result.completion.values;
    expect(values).toContain('POST');
    expect(values).toContain('PUT');
    expect(values).toContain('PATCH');
  });

  it('completion/complete 未知 ref 返回 MethodNotFound', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    const { json } = await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/resource', uri: 'faapi://unknown/{var}' },
          argument: { name: 'var', value: 'x' },
        },
      },
      sid,
    );

    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32601); // MethodNotFound
  });

  it('completion/complete 缺 ref 参数返回 InvalidParams', async () => {
    const mcp = createServer();
    const sid = await initialize(mcp);

    const { json } = await sendMcpPost(
      mcp,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'completion/complete',
        params: { argument: { name: 'method', value: 'G' } },
      },
      sid,
    );

    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32602);
  });
});
