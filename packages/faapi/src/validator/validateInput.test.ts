import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateInput, invalidateSchemaCache } from './validateInput';
import { generateSchemaFiles, getRuntimeSchemaPath } from '../cli/generateSchemaFiles';
import type { RouteManifest } from '../router/routeTypes';

describe('validateInput', () => {
  let tempDir: string;
  let schemaDist: string;

  beforeEach(async () => {
    invalidateSchemaCache();
    tempDir = join(
      tmpdir(),
      `faapi-validate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });

    // 写两个 handler 源文件到 tempDir（不同子目录，避免生成到同一 zod.js）
    mkdirSync(join(tempDir, 'route'), { recursive: true });
    writeFileSync(
      join(tempDir, 'route', 'route.ts'),
      `export interface GETQuery {
  page: number;
  pageSize: number;
  name?: string;
  active?: boolean;
}
export function GET(query: GETQuery) { return query; }
`,
    );
    mkdirSync(join(tempDir, 'noschema'), { recursive: true });
    writeFileSync(join(tempDir, 'noschema', 'noschema.ts'), `export const GET = () => 'hello';\n`);
    // 数组 body / 无 schema 的 POST handler
    mkdirSync(join(tempDir, 'arraybody'), { recursive: true });
    writeFileSync(
      join(tempDir, 'arraybody', 'arraybody.ts'),
      `export type POSTBody = string[];\nexport function POST(body: POSTBody) { return body; }\n`,
    );

    // 路由清单：filePath 用相对路径（相对 rootDir）
    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/route',
        filePath: 'route/route.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'GET',
        urlPath: '/api/noschema',
        filePath: 'noschema/noschema.ts',
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'POST',
        urlPath: '/api/arraybody',
        filePath: 'arraybody/arraybody.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    // 生成 zod.js 到 tempDir/schema-out/
    schemaDist = 'schema-out';
    await generateSchemaFiles(routes, tempDir, schemaDist);
  });

  afterEach(() => {
    invalidateSchemaCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** 计算 route/route.ts 对应的 zod.js 绝对路径 */
  function schemaPathFor(file: string): string {
    return getRuntimeSchemaPath(file, schemaDist, tempDir);
  }

  it('有类型声明时校验通过（已是正确类型）', async () => {
    const result = await validateInput(schemaPathFor('route/route.ts'), 'GET', 'query', {
      page: 1,
      pageSize: 10,
    });
    expect(result.valid).toBe(true);
  });

  it('query string 自动 coerce 为 number 后校验通过', async () => {
    const result = await validateInput(schemaPathFor('route/route.ts'), 'GET', 'query', {
      page: '1',
      pageSize: '20',
    });
    expect(result.valid).toBe(true);
    expect((result.data as Record<string, unknown>).page).toBe(1);
    expect((result.data as Record<string, unknown>).pageSize).toBe(20);
  });

  it('query string 自动 coerce 为 boolean 后校验通过', async () => {
    const result = await validateInput(schemaPathFor('route/route.ts'), 'GET', 'query', {
      page: '1',
      pageSize: '10',
      active: 'true',
    });
    expect(result.valid).toBe(true);
    expect((result.data as Record<string, unknown>).active).toBe(true);
  });

  it('coerce 失败时报类型不匹配错误', async () => {
    const result = await validateInput(schemaPathFor('route/route.ts'), 'GET', 'query', {
      page: 'abc',
      pageSize: '10',
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === 'page')).toBe(true);
    // preprocess 把 "abc" 原样传给 z.number()，zod 报 invalid_type
    expect(result.issues.some((i) => i.code === 'TYPE_MISMATCH')).toBe(true);
  });

  it('缺少必填字段仍报错', async () => {
    const result = await validateInput(schemaPathFor('route/route.ts'), 'GET', 'query', {
      page: '1',
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === 'pageSize')).toBe(true);
  });

  it('无类型声明时跳过校验', async () => {
    const result = await validateInput(schemaPathFor('noschema/noschema.ts'), 'GET', 'query', {
      any: 'thing',
    });
    expect(result.valid).toBe(true);
  });

  it('schema 模块加载失败时抛 InternalError', async () => {
    const nonExistent = join(tempDir, 'non-existent-zod.js');
    await expect(validateInput(nonExistent, 'GET', 'query', {})).rejects.toThrow(
      /Schema 模块加载失败/,
    );
  });

  it('数组 body + z.array schema: 校验通过且 data 保持数组', async () => {
    const result = await validateInput(schemaPathFor('arraybody/arraybody.ts'), 'POST', 'body', [
      'a',
      'b',
    ]);
    expect(result.valid).toBe(true);
    expect(result.data).toEqual(['a', 'b']);
  });

  it('数组 body 无 schema: data 原样保持数组（不再静默替换为 {}）', async () => {
    // noschema.ts 只有 GET——用 POST method 时 schema 名 POSTBodySchema 不存在 → 无 schema 分支
    const result = await validateInput(schemaPathFor('noschema/noschema.ts'), 'POST', 'body', [
      'x',
    ]);
    expect(result.valid).toBe(true);
    expect(result.data).toEqual(['x']);
  });
});
