import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchemaServer } from './schemaServer';
import { invalidateProgramCache } from '@faapi/faapi';
import type { RouteManifest } from '@faapi/faapi';

describe('schemaServer MCP tools', () => {
  let tempDir: string;

  beforeEach(() => {
    invalidateProgramCache();
    tempDir = join(tmpdir(), `faapi-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });

    // 写 handler 源文件：GET + POST /api/user
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

  async function connectClient() {
    const server = createSchemaServer(routes, tempDir);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(clientTransport);
    return client;
  }

  it('list_routes 返回所有路由', async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: 'list_routes', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const routesList = JSON.parse(text);

    expect(routesList).toHaveLength(2);
    expect(routesList[0]!.method).toBe('GET');
    expect(routesList[0]!.path).toBe('/api/user');
    expect(routesList[1]!.method).toBe('POST');
  });

  it('get_route_schema 返回单个路由详情', async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: 'get_route_schema',
      arguments: { method: 'GET', path: '/api/user' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const schema = JSON.parse(text);

    expect(schema.method).toBe('GET');
    expect(schema.path).toBe('/api/user');
    expect(schema.inputs[0]!.source).toBe('query');
    expect(schema.inputs[0]!.schemaName).toBe('GETQuery');
  });

  it('get_route_schema 未找到路由返回 error', async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: 'get_route_schema',
      arguments: { method: 'GET', path: '/api/not-exist' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const payload = JSON.parse(text);
    expect(payload.error).toContain('未找到路由');
  });

  it('get_api_schema 返回所有路由完整 schema', async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: 'get_api_schema',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const apiSchema = JSON.parse(text);

    const getKey = Object.keys(apiSchema);
    expect(getKey).toHaveLength(2);
    expect(getKey).toContain('GET /api/user');
    expect(getKey).toContain('POST /api/user');
    const getSchema = apiSchema['GET /api/user'];
    expect(getSchema.inputs[0]!.properties.length).toBeGreaterThan(0);
  });
});
