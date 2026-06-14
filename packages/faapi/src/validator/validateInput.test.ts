import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateInput } from './validateInput';
import { schemaRegistry } from './schemaRegistry';
import { extractSchemasForRoutes } from '../cli/generateSchema';
import type { RouteManifest } from '../router/routeTypes';

describe('validateInput', () => {
  let tempDir: string;
  let tempFile: string;
  let tempFileNoSchema: string;

  beforeEach(() => {
    schemaRegistry.clear();
    tempDir = join(tmpdir(), `faapi-validate-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    tempFile = join(tempDir, 'route.ts');
    writeFileSync(
      tempFile,
      `export interface GETQuery {
  page: number;
  pageSize: number;
  name?: string;
  active?: boolean;
}
export function GET(query: GETQuery) { return query; }
`,
    );
    // 提取 schema 并注册到 registry（经 extractSchemasForRoutes 单文件路由）
    // 两个文件合并到同一路由清单一次提取，避免 loadManifest 覆盖
    tempFileNoSchema = join(tempDir, 'noschema.ts');
    writeFileSync(tempFileNoSchema, `export const GET = () => 'hello';\n`);

    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/route',
        filePath: tempFile,
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'GET',
        urlPath: '/api/noschema',
        filePath: tempFileNoSchema,
        paramNames: [],
        isDynamic: false,
      },
    ];
    schemaRegistry.loadManifest(extractSchemasForRoutes(routes));
  });

  afterEach(() => {
    schemaRegistry.clear();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('有类型声明时校验通过（已是正确类型）', async () => {
    const result = await validateInput(tempFile, 'GET', 'query', { page: 1, pageSize: 10 });
    expect(result.valid).toBe(true);
  });

  it('query string 自动 coerce 为 number 后校验通过', async () => {
    const result = await validateInput(tempFile, 'GET', 'query', { page: '1', pageSize: '20' });
    expect(result.valid).toBe(true);
    expect(result.data.page).toBe(1);
    expect(result.data.pageSize).toBe(20);
  });

  it('query string 自动 coerce 为 boolean 后校验通过', async () => {
    const result = await validateInput(tempFile, 'GET', 'query', {
      page: '1',
      pageSize: '10',
      active: 'true',
    });
    expect(result.valid).toBe(true);
    expect(result.data.active).toBe(true);
  });

  it('coerce 失败时报校验错误', async () => {
    const result = await validateInput(tempFile, 'GET', 'query', { page: 'abc', pageSize: '10' });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === 'page')).toBe(true);
    expect(result.issues[0].message).toContain('无法将 "abc" 转为 number');
  });

  it('缺少必填字段仍报错', async () => {
    const result = await validateInput(tempFile, 'GET', 'query', { page: '1' });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === 'pageSize')).toBe(true);
  });

  it('无类型声明时跳过校验', async () => {
    const result = await validateInput(tempFileNoSchema, 'GET', 'query', { any: 'thing' });
    expect(result.valid).toBe(true);
  });

  it('schema 未注册时抛 InternalError', async () => {
    const unregisteredFile = join(tempDir, 'unregistered.ts');
    await expect(validateInput(unregisteredFile, 'GET', 'query', {})).rejects.toThrow(
      /Schema 未注册/,
    );
  });
});
