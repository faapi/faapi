import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectRouteSchemaSources } from './collectRouteSchemaSources';
import type { RouteManifest } from '../router/routeTypes';
import { invalidateProgramCache } from '../ast/createProgram';

describe('collectRouteSchemaSources', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-collect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    invalidateProgramCache();
  });

  afterEach(() => {
    invalidateProgramCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeHandler(fileName: string, content: string) {
    const filePath = join(tempDir, fileName);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  it('从含 interface 的 handler 提取 schema 类型信息', () => {
    const filePath = writeHandler(
      'hello.ts',
      `export interface Query { page: number; pageSize: number; }\nexport function GET(query: Query) { return query; }\n`,
    );
    const routes: RouteManifest = [
      { method: 'GET', urlPath: '/api/hello', filePath, paramNames: [], isDynamic: false },
    ];

    const { sources } = collectRouteSchemaSources(routes);
    expect(sources).toHaveLength(1);
    expect(sources[0].urlPath).toBe('/api/hello');
    expect(sources[0].schemaName).toBe('GETQuery');
    expect(sources[0].typeInfo).not.toBeNull();
    expect(sources[0].typeInfo!.name).toBe('Query');
  });

  it('无 input 类型参数的 handler typeInfo 为 null', () => {
    const filePath = writeHandler('ping.ts', `export function GET() { return { ok: true }; }\n`);
    const routes: RouteManifest = [
      { method: 'GET', urlPath: '/api/ping', filePath, paramNames: [], isDynamic: false },
    ];

    const { sources } = collectRouteSchemaSources(routes);
    expect(sources).toHaveLength(1);
    expect(sources[0].typeInfo).toBeNull();
  });

  it('多方法同文件分组到同一次 AST 解析', () => {
    const filePath = writeHandler(
      'multi.ts',
      `export interface Query { q: string; }\nexport interface Body { name: string; }\nexport function GET(query: Query) { return query; }\nexport function POST(body: Body) { return body; }\n`,
    );
    const routes: RouteManifest = [
      { method: 'GET', urlPath: '/api/multi', filePath, paramNames: [], isDynamic: false },
      { method: 'POST', urlPath: '/api/multi', filePath, paramNames: [], isDynamic: false },
    ];

    const { sources, allTypesByFile } = collectRouteSchemaSources(routes);
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.schemaName).sort()).toEqual(['GETQuery', 'POSTBody']);
    // 同文件只解析一次
    expect(allTypesByFile.size).toBe(1);
    const types = allTypesByFile.get(filePath)!;
    expect(types.has('Query')).toBe(true);
    expect(types.has('Body')).toBe(true);
  });

  it('rootDir 传入时解析为绝对路径', () => {
    writeHandler(
      'sub/nested.ts',
      `export interface Query { id: string; }\nexport function GET(query: Query) { return query; }\n`,
    );
    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/sub/nested',
        filePath: 'sub/nested.ts',
        paramNames: [],
        isDynamic: false,
      },
    ];

    const { sources } = collectRouteSchemaSources(routes, tempDir);
    expect(sources).toHaveLength(1);
    expect(sources[0].typeInfo).not.toBeNull();
    expect(sources[0].typeInfo!.name).toBe('Query');
  });

  it('mergedAllTypes 合并所有文件的类型', () => {
    writeHandler(
      'a.ts',
      `export interface QA { a: string; }\nexport function GET(q: QA) { return q; }\n`,
    );
    writeHandler(
      'b.ts',
      `export interface QB { b: number; }\nexport function POST(q: QB) { return q; }\n`,
    );
    const routes: RouteManifest = [
      {
        method: 'GET',
        urlPath: '/api/a',
        filePath: join(tempDir, 'a.ts'),
        paramNames: [],
        isDynamic: false,
      },
      {
        method: 'POST',
        urlPath: '/api/b',
        filePath: join(tempDir, 'b.ts'),
        paramNames: [],
        isDynamic: false,
      },
    ];

    const { mergedAllTypes } = collectRouteSchemaSources(routes);
    expect(mergedAllTypes.has('QA')).toBe(true);
    expect(mergedAllTypes.has('QB')).toBe(true);
  });
});
