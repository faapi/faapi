import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRouteSchemas } from './routeSchema';
import { invalidateProgramCache } from '@faapi/faapi';
import type { RouteManifest } from '@faapi/faapi';

describe('buildRouteSchemas', () => {
  let tempDir: string;

  beforeEach(() => {
    invalidateProgramCache();
    tempDir = join(
      tmpdir(),
      `faapi-schema-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    invalidateProgramCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('从源文件提取 GET 路由的 query schema', () => {
    // 写 handler 源文件
    mkdirSync(join(tempDir, 'api/user'), { recursive: true });
    writeFileSync(
      join(tempDir, 'api/user/handler.ts'),
      `export interface GETQuery { page: number; pageSize: number; }\nexport function GET(query: GETQuery) { return query; }\n`,
      'utf-8',
    );

    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/user',
        filePath: 'api/user/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];
    const schemas = buildRouteSchemas(routes, tempDir);

    expect(schemas).toHaveLength(1);
    const schema = schemas[0]!;
    expect(schema.method).toBe('GET');
    expect(schema.path).toBe('/api/user');
    expect(schema.isDynamic).toBe(false);
    expect(schema.inputs[0]!.source).toBe('query');
    expect(schema.inputs[0]!.schemaName).toBe('GETQuery');
    expect(schema.inputs[0]!.properties).toHaveLength(2);
    expect(schema.inputs[0]!.properties[0]).toEqual({
      name: 'page',
      type: 'number',
      required: true,
    });
  });

  it('从源文件提取 POST 路由的 body schema', () => {
    mkdirSync(join(tempDir, 'api/user'), { recursive: true });
    writeFileSync(
      join(tempDir, 'api/user/handler.ts'),
      `export interface POSTBody { name: string; email: string; }\nexport function POST(body: POSTBody) { return body; }\n`,
      'utf-8',
    );

    const routes: RouteManifest = [
      {
        method: 'POST',
        urlPath: '/api/user',
        filePath: 'api/user/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];
    const schemas = buildRouteSchemas(routes, tempDir);

    const schema = schemas[0]!;
    expect(schema.inputs[0]!.source).toBe('body');
    expect(schema.inputs[0]!.schemaName).toBe('POSTBody');
    expect(schema.inputs[0]!.properties[0]).toEqual({
      name: 'name',
      type: 'string',
      required: true,
    });
  });

  it('无类型声明时返回空 properties', () => {
    mkdirSync(join(tempDir, 'api/health'), { recursive: true });
    writeFileSync(
      join(tempDir, 'api/health/handler.ts'),
      `export function GET() { return { ok: true }; }\n`,
      'utf-8',
    );

    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/health',
        filePath: 'api/health/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];
    const schemas = buildRouteSchemas(routes, tempDir);

    const schema = schemas[0]!;
    expect(schema.inputs[0]!.source).toBe('query');
    expect(schema.inputs[0]!.schemaName).toBeNull();
    expect(schema.inputs[0]!.properties).toEqual([]);
  });

  it('动态路由用 paramNames 兜底生成 params 输入', () => {
    mkdirSync(join(tempDir, 'api/user/[id]'), { recursive: true });
    writeFileSync(
      join(tempDir, 'api/user/[id]/handler.ts'),
      `export function GET(params: { id: string }) { return params; }\n`,
      'utf-8',
    );

    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/user/:id',
        filePath: 'api/user/[id]/handler.ts',
        paramNames: ['id'],
        isDynamic: true,
      },
    ];
    const schemas = buildRouteSchemas(routes, tempDir);

    const schema = schemas[0]!;
    expect(schema.isDynamic).toBe(true);
    const paramsInput = schema.inputs.find((i) => i.source === 'params');
    expect(paramsInput).toBeDefined();
    expect(paramsInput!.properties).toHaveLength(1);
    expect(paramsInput!.properties[0]!.name).toBe('id');
    expect(paramsInput!.properties[0]!.type).toBe('string');
  });

  it('RuntimeType 正确转换为字符串', () => {
    mkdirSync(join(tempDir, 'api/echo'), { recursive: true });
    writeFileSync(
      join(tempDir, 'api/echo/handler.ts'),
      `export interface POSTBody {
  name: string;
  tags?: string[];
  role: 'admin' | 'user';
}
export function POST(body: POSTBody) { return body; }\n`,
      'utf-8',
    );

    const routes: RouteManifest = [
      {
        method: 'POST',
        urlPath: '/api/echo',
        filePath: 'api/echo/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];
    const schemas = buildRouteSchemas(routes, tempDir);

    const props = schemas[0]!.inputs[0]!.properties;
    expect(props[0]!.type).toBe('string');
    expect(props[1]!.type).toBe('string[]');
    expect(props[1]!.required).toBe(false);
    expect(props[2]!.type).toBe('"admin" | "user"');
  });
});
