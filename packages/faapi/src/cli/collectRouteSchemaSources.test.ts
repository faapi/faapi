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

  it('handler 声明 form 参数时提取 schema 并标记 coerce=true（schema 名仍为 POSTBody）', () => {
    const filePath = writeHandler(
      'login.ts',
      `export interface LoginForm { username: string; age: number; }\nexport function POST(form: LoginForm) { return form; }\n`,
    );
    const routes: RouteManifest = [
      { method: 'POST', urlPath: '/api/login', filePath, paramNames: [], isDynamic: false },
    ];

    const { sources } = collectRouteSchemaSources(routes);
    expect(sources).toHaveLength(1);
    // schema 名仍为 POSTBody（与 body 共享运行时 schema key）
    expect(sources[0].schemaName).toBe('POSTBody');
    expect(sources[0].typeInfo).not.toBeNull();
    expect(sources[0].typeInfo!.name).toBe('LoginForm');
    // form 声明时显式标记 coerce=true
    expect(sources[0].coerce).toBe(true);
  });

  it('handler 声明 body 参数时 coerce 为 undefined（回退到 schemaName 正则）', () => {
    const filePath = writeHandler(
      'user.ts',
      `export interface CreateUserBody { name: string; age: number; }\nexport function POST(body: CreateUserBody) { return body; }\n`,
    );
    const routes: RouteManifest = [
      { method: 'POST', urlPath: '/api/user', filePath, paramNames: [], isDynamic: false },
    ];

    const { sources } = collectRouteSchemaSources(routes);
    expect(sources[0].schemaName).toBe('POSTBody');
    expect(sources[0].typeInfo!.name).toBe('CreateUserBody');
    // body 声明时不设置 coerce（回退到正则推断为 false）
    expect(sources[0].coerce).toBeUndefined();
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

    const { sources, resolversByFile } = collectRouteSchemaSources(routes);
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.schemaName).sort()).toEqual(['GETQuery', 'POSTBody']);
    // 同文件一个惰性解析器
    expect(resolversByFile.size).toBe(1);
    const resolver = resolversByFile.get(filePath)!;
    expect(resolver.resolve('Query')).not.toBeNull();
    expect(resolver.resolve('Body')).not.toBeNull();
    expect(resolver.resolve('NoSuchType')).toBeNull();
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

  it('无关类型含不支持语法不拖垮提取（惰性解析：只解析入口类型）', () => {
    // Unused 的 any 字段在 SchemaExtractionError 抛错名单中，
    // 但它不被任何路由入口类型引用——惰性解析下不应被解析，提取应成功
    const filePath = writeHandler(
      'lazy.ts',
      `export interface Unused { bad: any; }\nexport interface Query { q: string; }\nexport function GET(query: Query) { return query; }\n`,
    );
    const routes: RouteManifest = [
      { method: 'GET', urlPath: '/api/lazy', filePath, paramNames: [], isDynamic: false },
    ];

    const { sources } = collectRouteSchemaSources(routes);
    expect(sources).toHaveLength(1);
    expect(sources[0].typeInfo).not.toBeNull();
    expect(sources[0].typeInfo!.name).toBe('Query');
  });

  it('resolversByFile 惰性解析：缓存幂等（同一类型返回同一实例）', () => {
    const filePath = writeHandler(
      'cached.ts',
      `export interface Query { q: string; }\nexport function GET(query: Query) { return query; }\n`,
    );
    const routes: RouteManifest = [
      { method: 'GET', urlPath: '/api/cached', filePath, paramNames: [], isDynamic: false },
    ];

    const { resolversByFile } = collectRouteSchemaSources(routes);
    const resolver = resolversByFile.get(filePath)!;
    const first = resolver.resolve('Query');
    expect(first).not.toBeNull();
    // 缓存命中：返回同一实例（不重复解析）
    expect(resolver.resolve('Query')).toBe(first);
  });

  it('循环引用：入口类型 runtimeType 中的 ref 可经 resolver 解析', () => {
    const filePath = writeHandler(
      'cyclic.ts',
      `export interface TreeNode { children: TreeNode[]; }\nexport function POST(body: TreeNode) { return body; }\n`,
    );
    const routes: RouteManifest = [
      { method: 'POST', urlPath: '/api/cyclic', filePath, paramNames: [], isDynamic: false },
    ];

    const { sources, resolversByFile } = collectRouteSchemaSources(routes);
    const runtimeType = sources[0].typeInfo!.runtimeType;
    // 自引用字段解析为 ref（generateZodSchema 用 z.lazy 处理）
    expect(runtimeType.kind).toBe('object');
    const children = sources[0].typeInfo!.properties.find((p) => p.name === 'children');
    expect(children?.type).toEqual({ kind: 'array', element: { kind: 'ref', name: 'TreeNode' } });

    // ref 可经 resolver 解析回完整类型信息
    const resolver = resolversByFile.get(filePath)!;
    const resolved = resolver.resolve('TreeNode');
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('TreeNode');
  });
});
