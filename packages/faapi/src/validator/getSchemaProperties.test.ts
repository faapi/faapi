import { describe, it, expect, beforeEach } from 'vitest';
import { getSchemaProperties } from './getSchemaProperties';
import { schemaRegistry } from './schemaRegistry';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/injection-test');
const FILE_PATH = path.resolve(FIXTURES_DIR, 'api/user/handler.ts');

describe('getSchemaProperties', () => {
  beforeEach(() => {
    schemaRegistry.clear();
  });

  it('从 registry 查询已有 schema', () => {
    // 模拟 registry 已有的数据
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
      ]),
    );

    const result = getSchemaProperties(FILE_PATH, 'GET', 'query');
    expect(result).toBeDefined();
    expect(result!.schemaName).toBe('GETQuery');
    expect(result!.properties).toHaveLength(2);
    expect(result!.properties[0]).toEqual({ name: 'page', type: 'number', required: true });
    expect(result!.properties[1]).toEqual({ name: 'pageSize', type: 'number', required: true });
  });

  it('无类型声明返回空 properties', () => {
    schemaRegistry.set(FILE_PATH, new Map([['GETQuery', null]]));

    const result = getSchemaProperties(FILE_PATH, 'GET', 'query');
    expect(result).toBeDefined();
    expect(result!.schemaName).toBeNull();
    expect(result!.properties).toEqual([]);
  });

  it('registry 无数据时返回 undefined', () => {
    const result = getSchemaProperties(FILE_PATH, 'GET', 'query');
    expect(result).toBeUndefined();
  });

  it('RuntimeType 正确转换为字符串', () => {
    schemaRegistry.set(
      FILE_PATH,
      new Map([
        [
          'POSTBody',
          {
            properties: [
              { name: 'name', type: { kind: 'string' }, optional: false },
              {
                name: 'tags',
                type: { kind: 'array', element: { kind: 'string' } },
                optional: true,
              },
              {
                name: 'role',
                type: {
                  kind: 'union',
                  members: [
                    { kind: 'literal', value: 'admin' },
                    { kind: 'literal', value: 'user' },
                  ],
                },
                optional: false,
              },
            ],
            validator: () => ({ valid: true, issues: [], data: {} }),
          },
        ],
      ]),
    );

    const result = getSchemaProperties(FILE_PATH, 'POST', 'body');
    expect(result!.properties[0]!.type).toBe('string');
    expect(result!.properties[1]!.type).toBe('string[]');
    expect(result!.properties[1]!.required).toBe(false);
    expect(result!.properties[2]!.type).toBe('"admin" | "user"');
  });
});
