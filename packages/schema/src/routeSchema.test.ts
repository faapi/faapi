import { describe, it, expect, beforeEach } from 'vitest';
import { buildRouteSchemas } from './routeSchema';
import type { RouteManifest } from '@faapi/faapi';
// @ts-expect-error — vitest alias 指向主包 src，运行时可用
import { schemaRegistry } from '@faapi/faapi/src/validator/schemaRegistry';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../faapi/fixtures/injection-test');
const BASIC_FIXTURES = path.resolve(__dirname, '../../faapi/fixtures/api-basic');

describe('buildRouteSchemas', () => {
  beforeEach(() => {
    schemaRegistry.clear();
  });

  it('从 registry 查询 GET 路由的 query schema', () => {
    const filePath = path.resolve(FIXTURES_DIR, 'api/user/handler.ts');

    // 填充 registry（模拟 startCommand 已提取 schema）
    schemaRegistry.set(
      filePath,
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
      ]),
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
    const schemas = buildRouteSchemas(routes, FIXTURES_DIR);

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

  it('从 registry 查询 POST 路由的 body schema', () => {
    const filePath = path.resolve(FIXTURES_DIR, 'api/user/handler.ts');

    schemaRegistry.set(
      filePath,
      new Map([
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

    const routes: RouteManifest = [
      {
        method: 'POST',
        urlPath: '/api/user',
        filePath: 'api/user/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];
    const schemas = buildRouteSchemas(routes, FIXTURES_DIR);

    const schema = schemas[0]!;
    expect(schema.inputs[0]!.source).toBe('body');
    expect(schema.inputs[0]!.schemaName).toBe('POSTBody');
    expect(schema.inputs[0]!.properties[0]).toEqual({
      name: 'name',
      type: 'string',
      required: true,
    });
  });

  it('registry 无数据时返回空 properties', () => {
    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/health',
        filePath: 'api/health/handler.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];
    const schemas = buildRouteSchemas(routes, BASIC_FIXTURES);

    const schema = schemas[0]!;
    expect(schema.inputs[0]!.source).toBe('query');
    expect(schema.inputs[0]!.schemaName).toBeNull();
    expect(schema.inputs[0]!.properties).toEqual([]);
  });

  it('动态路由生成 params 输入', () => {
    const filePath = path.resolve(BASIC_FIXTURES, 'api/user/[id]/handler.ts');

    schemaRegistry.set(
      filePath,
      new Map([
        ['GETQuery', null], // 无 query 类型
        ['GETParams', null], // 无 params 类型
      ]),
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
    const schemas = buildRouteSchemas(routes, BASIC_FIXTURES);

    const schema = schemas[0]!;
    expect(schema.isDynamic).toBe(true);
    const paramsInput = schema.inputs.find((i) => i.source === 'params');
    expect(paramsInput).toBeDefined();
    expect(paramsInput!.properties).toHaveLength(1);
    expect(paramsInput!.properties[0]!.name).toBe('id');
    expect(paramsInput!.properties[0]!.type).toBe('string');
  });
});
