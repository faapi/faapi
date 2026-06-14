import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchemaServer } from './schemaServer';
import type { RouteManifest } from '@faapi/faapi';
// @ts-expect-error — vitest alias 指向主包 src，运行时可用
import { schemaRegistry } from '@faapi/faapi/src/validator/schemaRegistry';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../faapi/fixtures/injection-test');
const FILE_PATH = path.resolve(FIXTURES_DIR, 'api/user/handler.ts');

// 构造最小路由清单：GET /api/user + POST /api/user
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

// 填充 registry（模拟 startCommand 已提取 schema）
function seedRegistry() {
  schemaRegistry.set(
    FILE_PATH,
    new Map([
      [
        'GETQuery',
        {
          properties: [
            { name: 'page', type: { kind: 'number' }, optional: false },
            { name: 'pageSize', type: { kind: 'number' }, optional: false },
          ],
          validator: () => ({ valid: true, issues: [], data: {} }),
        },
      ],
      [
        'POSTBody',
        {
          properties: [
            { name: 'name', type: { kind: 'string' }, optional: false },
            { name: 'email', type: { kind: 'string' }, optional: false },
          ],
          validator: () => ({ valid: true, issues: [], data: {} }),
        },
      ],
    ]),
  );
}

async function connectClient() {
  seedRegistry();
  const server = createSchemaServer(routes, FIXTURES_DIR);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

describe('schemaServer MCP tools', () => {
  beforeEach(() => {
    schemaRegistry.clear();
  });

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
