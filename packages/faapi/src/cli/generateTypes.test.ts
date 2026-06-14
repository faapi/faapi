import { describe, it, expect, beforeEach } from 'vitest';
import { generateTypes, routeKey, methodName } from './generateTypes';
import type { RouteManifest } from '../router/routeTypes';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('generateTypes', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'faapi-test-'));
  });

  it('从路由清单生成正确的类型文件', async () => {
    // 创建模拟路由文件
    const handlerCode = `
      export interface Query { page: number; pageSize: number; }
      export function GET(query: Query) { return { items: [] }; }
    `;
    const handlerPath = path.join(tmpDir, 'api', 'items');
    await fs.mkdir(handlerPath, { recursive: true });
    await fs.writeFile(path.join(handlerPath, 'handler.ts'), handlerCode, 'utf-8');

    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/items',
        filePath: 'api/items/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const outputPath = path.join(tmpDir, 'faapi-types.ts');
    await generateTypes(routes, tmpDir, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toContain('export namespace FaapiRoutes');
    expect(content).toContain('interface GET_api_items');
    expect(content).toContain("method: 'GET'");
    expect(content).toContain("path: '/api/items'");
    expect(content).toContain('input: Query');
    expect(content).toContain('output: unknown');
    expect(content).toContain("'GET /api/items': GET_api_items");
    expect(content).toContain('export interface FaapiClient');
    expect(content).toContain("get('/api/items', input): Promise<unknown>");
  });

  it('处理无输入的路由', async () => {
    const handlerCode = `
      export function GET() { return { status: 'ok' }; }
    `;
    const handlerPath = path.join(tmpDir, 'api', 'health');
    await fs.mkdir(handlerPath, { recursive: true });
    await fs.writeFile(path.join(handlerPath, 'handler.ts'), handlerCode, 'utf-8');

    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/health',
        filePath: 'api/health/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const outputPath = path.join(tmpDir, 'faapi-types.ts');
    await generateTypes(routes, tmpDir, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toContain('input: void');
    expect(content).toContain("get('/api/health'): Promise<unknown>");
  });

  it('处理有类型输入的 POST 路由', async () => {
    const handlerCode = `
      export interface CreateUserBody { name: string; email: string; }
      export function POST(body: CreateUserBody) { return { created: true }; }
    `;
    const handlerPath = path.join(tmpDir, 'api', 'user');
    await fs.mkdir(handlerPath, { recursive: true });
    await fs.writeFile(path.join(handlerPath, 'handler.ts'), handlerCode, 'utf-8');

    const routes: RouteManifest = [
      {
        method: 'POST',
        urlPath: '/api/user',
        filePath: 'api/user/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const outputPath = path.join(tmpDir, 'faapi-types.ts');
    await generateTypes(routes, tmpDir, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toContain('input: CreateUserBody');
    expect(content).toContain("post('/api/user', input): Promise<unknown>");
  });

  it('处理多个路由', async () => {
    const handlerCode1 = `
      export function GET() { return { list: [] }; }
    `;
    const handlerCode2 = `
      export interface Body { title: string; }
      export function POST(body: Body) { return { id: 1 }; }
    `;

    const dir1 = path.join(tmpDir, 'api', 'items');
    const dir2 = path.join(tmpDir, 'api', 'orders');
    await fs.mkdir(dir1, { recursive: true });
    await fs.mkdir(dir2, { recursive: true });
    await fs.writeFile(path.join(dir1, 'handler.ts'), handlerCode1, 'utf-8');
    await fs.writeFile(path.join(dir2, 'handler.ts'), handlerCode2, 'utf-8');

    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/items',
        filePath: 'api/items/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'POST',
        urlPath: '/api/orders',
        filePath: 'api/orders/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const outputPath = path.join(tmpDir, 'faapi-types.ts');
    await generateTypes(routes, tmpDir, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toContain('interface GET_api_items');
    expect(content).toContain('interface POST_api_orders');
    expect(content).toContain("'GET /api/items': GET_api_items");
    expect(content).toContain("'POST /api/orders': POST_api_orders");
    expect(content).toContain("get('/api/items'): Promise<unknown>");
    expect(content).toContain("post('/api/orders', input): Promise<unknown>");
  });

  it('跳过无法读取的路由文件', async () => {
    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/missing',
        filePath: 'api/missing/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const outputPath = path.join(tmpDir, 'faapi-types.ts');
    await generateTypes(routes, tmpDir, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    // 应该没有路由接口（因为文件不存在）
    expect(content).not.toContain('interface GET_api_missing');
  });

  it('自动创建输出目录', async () => {
    const handlerCode = `export function GET() { return {} }`;
    const handlerPath = path.join(tmpDir, 'api', 'test');
    await fs.mkdir(handlerPath, { recursive: true });
    await fs.writeFile(path.join(handlerPath, 'handler.ts'), handlerCode, 'utf-8');

    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/test',
        filePath: 'api/test/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const outputPath = path.join(tmpDir, 'nested', 'dir', 'faapi-types.ts');
    await generateTypes(routes, tmpDir, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toContain('interface GET_api_test');
  });

  it('GET/DELETE 路由使用 query 作为输入源', async () => {
    const handlerCode = `
      export interface Query { id: string; }
      export function DELETE(query: Query) { return { deleted: true }; }
    `;
    const handlerPath = path.join(tmpDir, 'api', 'item');
    await fs.mkdir(handlerPath, { recursive: true });
    await fs.writeFile(path.join(handlerPath, 'handler.ts'), handlerCode, 'utf-8');

    const routes: RouteManifest = [
      {
        method: 'DELETE',
        urlPath: '/api/item',
        filePath: 'api/item/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const outputPath = path.join(tmpDir, 'faapi-types.ts');
    await generateTypes(routes, tmpDir, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toContain('input: Query');
    expect(content).toContain("delete('/api/item', input): Promise<unknown>");
  });

  it('无类型标注的参数使用 Record<string, unknown>', async () => {
    const handlerCode = `
      export function POST(body) { return {} }
    `;
    const handlerPath = path.join(tmpDir, 'api', 'raw');
    await fs.mkdir(handlerPath, { recursive: true });
    await fs.writeFile(path.join(handlerPath, 'handler.ts'), handlerCode, 'utf-8');

    const routes: RouteManifest = [
      {
        method: 'POST',
        urlPath: '/api/raw',
        filePath: 'api/raw/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const outputPath = path.join(tmpDir, 'faapi-types.ts');
    await generateTypes(routes, tmpDir, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toContain('input: Record<string, unknown>');
  });
});

describe('routeKey', () => {
  it('生成简单路径的路由键', () => {
    expect(routeKey('GET', '/items')).toBe('GET_items');
  });

  it('生成根路径的路由键', () => {
    expect(routeKey('GET', '/')).toBe('GET_root');
  });

  it('处理带动态参数的路径', () => {
    expect(routeKey('GET', '/user/:id')).toBe('GET_user_id');
  });

  it('处理多层嵌套路径', () => {
    expect(routeKey('POST', '/api/user/profile')).toBe('POST_api_user_profile');
  });

  it('处理带连字符的路径', () => {
    expect(routeKey('GET', '/my-resource')).toBe('GET_my_resource');
  });
});

describe('methodName', () => {
  it('将 GET 转为 get', () => {
    expect(methodName('GET')).toBe('get');
  });

  it('将 POST 转为 post', () => {
    expect(methodName('POST')).toBe('post');
  });

  it('将 DELETE 转为 delete', () => {
    expect(methodName('DELETE')).toBe('delete');
  });

  it('将 PUT 转为 put', () => {
    expect(methodName('PUT')).toBe('put');
  });
});
