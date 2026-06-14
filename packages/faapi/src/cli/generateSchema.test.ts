import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractSchemasForRoutes, readManifestFile, writeSchemaModule } from './generateSchema';
import { createProgram } from '../ast/createProgram';
import { extractTypeInfo, extractAllTypes } from '../ast/extractHandlerTypes';
import { getInputTypeForMethod } from '../runtime/inputType';
import { getSchemaName } from '../validator/schemaName';
import type { SchemaModuleEntry } from '../ast/generateValidatorCode';
import type { RouteManifest } from '../router/routeTypes';

describe('generateSchema', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-gen-schema-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // 构造单文件路由清单，复用 extractSchemasForRoutes（生产唯一入口）
  function singleFileRoutes(filePath: string, methods: string[]): RouteManifest {
    return methods.map((method) => ({
      method: method as any,
      urlPath: `/api/test`,
      filePath,
      paramNames: [],
      isDynamic: false,
    }));
  }

  describe('单文件提取（经 extractSchemasForRoutes）', () => {
    it('提取有类型声明的 schema', () => {
      const filePath = join(tempDir, 'user.ts');
      writeFileSync(
        filePath,
        `export interface GETQuery {
  page: number;
  name?: string;
}
export function GET(query: GETQuery) { return query; }
`,
      );

      const manifest = extractSchemasForRoutes(singleFileRoutes(filePath, ['GET']));
      const schemas = manifest.get(filePath)!;

      // 存储 key 仍为约定名 GETQuery
      expect(schemas.has('GETQuery')).toBe(true);
      const entry = schemas.get('GETQuery');
      expect(entry).not.toBeNull();
      expect(entry!.properties.length).toBe(2);
      expect(entry!.properties[0].name).toBe('page');
      expect(typeof entry!.validator).toBe('function');
    });

    it('类型名可自由命名（不强制为约定名）', () => {
      // 用户写 interface Query 而非 GETQuery，也应被正确提取
      const filePath = join(tempDir, 'user.ts');
      writeFileSync(
        filePath,
        `export interface Query {
  page: number;
  name?: string;
}
export function GET(query: Query) { return query; }
`,
      );

      const manifest = extractSchemasForRoutes(singleFileRoutes(filePath, ['GET']));
      const schemas = manifest.get(filePath)!;

      // 存储 key 仍是约定名 GETQuery（运行时查找不变），但 schema 来自真实类型 Query
      expect(schemas.has('GETQuery')).toBe(true);
      const entry = schemas.get('GETQuery');
      expect(entry).not.toBeNull();
      expect(entry!.properties.length).toBe(2);
      expect(entry!.properties[0].name).toBe('page');
      expect(typeof entry!.validator).toBe('function');

      // 校验函数应能正确校验
      const ok = entry!.validator({ page: 1 });
      expect(ok.valid).toBe(true);
      const missing = entry!.validator({});
      expect(missing.valid).toBe(false);
    });

    it('POST body 类型名可自由命名', () => {
      const filePath = join(tempDir, 'user.ts');
      writeFileSync(
        filePath,
        `export interface CreateUserBody {
  name: string;
  email: string;
}
export function POST(body: CreateUserBody) { return body; }
`,
      );

      const manifest = extractSchemasForRoutes(singleFileRoutes(filePath, ['POST']));
      const schemas = manifest.get(filePath)!;

      expect(schemas.has('POSTBody')).toBe(true);
      const entry = schemas.get('POSTBody');
      expect(entry).not.toBeNull();
      expect(entry!.properties.map((p) => p.name).sort()).toEqual(['email', 'name']);
    });

    it('无类型声明时 schema 为 null', () => {
      const filePath = join(tempDir, 'health.ts');
      writeFileSync(filePath, `export function GET() { return 'ok'; }\n`);

      const manifest = extractSchemasForRoutes(singleFileRoutes(filePath, ['GET']));
      const schemas = manifest.get(filePath)!;

      expect(schemas.get('GETQuery')).toBeNull();
    });

    it('多方法提取各自的 schema', () => {
      const filePath = join(tempDir, 'user.ts');
      writeFileSync(
        filePath,
        `export interface GETQuery { id: string; }
export interface POSTBody { name: string; }
export function GET(query: GETQuery) { return query; }
export function POST(body: POSTBody) { return body; }
`,
      );

      const manifest = extractSchemasForRoutes(singleFileRoutes(filePath, ['GET', 'POST']));
      const schemas = manifest.get(filePath)!;

      expect(schemas.has('GETQuery')).toBe(true);
      expect(schemas.has('POSTBody')).toBe(true);
      expect(schemas.get('GETQuery')!.properties[0].name).toBe('id');
      expect(schemas.get('POSTBody')!.properties[0].name).toBe('name');
    });

    it('生成的校验函数能正确校验输入', () => {
      const filePath = join(tempDir, 'user.ts');
      writeFileSync(
        filePath,
        `export interface GETQuery { page: number; name?: string; }
export function GET(query: GETQuery) { return query; }
`,
      );

      const manifest = extractSchemasForRoutes(singleFileRoutes(filePath, ['GET']));
      const entry = manifest.get(filePath)!.get('GETQuery')!;

      // 正确输入
      const ok = entry.validator({ page: 1 });
      expect(ok.valid).toBe(true);

      // 缺少必填字段
      const missing = entry.validator({});
      expect(missing.valid).toBe(false);
      expect(missing.issues.some((i) => i.path === 'page')).toBe(true);

      // 类型错误
      const wrongType = entry.validator({ page: '1' });
      expect(wrongType.valid).toBe(false);
    });
  });

  describe('extractSchemasForRoutes', () => {
    it('从路由清单提取完整 manifest', () => {
      const file1 = join(tempDir, 'user.ts');
      const file2 = join(tempDir, 'health.ts');
      writeFileSync(
        file1,
        `export interface GETQuery { page: number; }
export function GET(query: GETQuery) { return query; }
`,
      );
      writeFileSync(file2, `export function GET() { return 'ok'; }\n`);

      const routes: RouteManifest = [
        { method: 'GET', urlPath: '/api/user', filePath: file1, paramNames: [], isDynamic: false },
        {
          method: 'GET',
          urlPath: '/api/health',
          filePath: file2,
          paramNames: [],
          isDynamic: false,
        },
      ];

      const manifest = extractSchemasForRoutes(routes);

      expect(manifest.size).toBe(2);
      expect(manifest.get(file1)!.get('GETQuery')!.properties[0].name).toBe('page');
      expect(manifest.get(file2)!.get('GETQuery')).toBeNull();
    });

    it('同一文件多方法合并到同一 FileSchemas', () => {
      const filePath = join(tempDir, 'user.ts');
      writeFileSync(
        filePath,
        `export interface GETQuery { id: string; }
export interface POSTBody { name: string; }
export function GET(query: GETQuery) { return query; }
export function POST(body: POSTBody) { return body; }
`,
      );

      const routes: RouteManifest = [
        { method: 'GET', urlPath: '/api/user', filePath, paramNames: [], isDynamic: false },
        { method: 'POST', urlPath: '/api/user', filePath, paramNames: [], isDynamic: false },
      ];

      const manifest = extractSchemasForRoutes(routes);

      expect(manifest.size).toBe(1);
      const fileSchemas = manifest.get(filePath)!;
      expect(fileSchemas.size).toBe(2);
      expect(fileSchemas.has('GETQuery')).toBe(true);
      expect(fileSchemas.has('POSTBody')).toBe(true);
    });

    it('跨文件类型引用可解析（与 prd 行为一致）', () => {
      // 文件 A 的 GETQuery 引用文件 B 的 B 类型，文件 B 的 GETQuery 引用文件 A 的 A 类型（跨文件循环引用）
      const fileA = join(tempDir, 'a.ts');
      const fileB = join(tempDir, 'b.ts');
      writeFileSync(
        fileA,
        `export interface B { id: number; }
export interface GETQuery { b: B; }
export function GET(query: GETQuery) { return query; }
`,
      );
      writeFileSync(
        fileB,
        `export interface GETQuery { id: number; a?: A; }
export interface A { b: B; }
export interface B { id: number; }
export function GET(query: GETQuery) { return query; }
`,
      );

      const routes: RouteManifest = [
        { method: 'GET', urlPath: '/api/a', filePath: fileA, paramNames: [], isDynamic: false },
        { method: 'GET', urlPath: '/api/b', filePath: fileB, paramNames: [], isDynamic: false },
      ];

      const manifest = extractSchemasForRoutes(routes);

      // 文件 A 的 schema 应能校验含 B 的对象
      const entryA = manifest.get(fileA)!.get('GETQuery')!;
      expect(entryA).not.toBeNull();
      const okA = entryA.validator({ b: { id: 1 } });
      expect(okA.valid).toBe(true);

      // 文件 B 的 schema 应能校验含 A 的对象（跨文件循环引用）
      const entryB = manifest.get(fileB)!.get('GETQuery')!;
      expect(entryB).not.toBeNull();
      const okB = entryB.validator({ id: 1, a: { b: { id: 2 } } });
      expect(okB.valid).toBe(true);

      // 跨文件循环引用数据（环）也能正确处理
      const cyclic: Record<string, unknown> = { id: 1 };
      cyclic.a = { b: cyclic };
      const okCyclic = entryB.validator(cyclic);
      expect(okCyclic.valid).toBe(true);
    });
  });

  describe('writeSchemaModule / readManifestFile', () => {
    it('写入并读取 schema JS 模块（往返一致）', async () => {
      const filePath = join(tempDir, 'user.ts');
      writeFileSync(
        filePath,
        `export interface GETQuery { page: number; }
export function GET(query: GETQuery) { return query; }
`,
      );

      // 构建 entries 和 allTypesMap
      const program = createProgram(filePath);
      const allTypes = extractAllTypes(program, filePath);
      const schemaName = getSchemaName('GET', getInputTypeForMethod('GET'));
      const typeInfo = extractTypeInfo(program, filePath, schemaName);
      const entries: SchemaModuleEntry[] = [{ filePath, schemaName, typeInfo }];
      const allTypesMap = new Map([[filePath, allTypes]]);

      const outputPath = join(tempDir, 'faapi-schema.js');
      await writeSchemaModule(entries, allTypesMap, outputPath);

      expect(existsSync(outputPath)).toBe(true);

      const loaded = await readManifestFile(outputPath);

      expect(loaded.size).toBe(1);
      const entry = loaded.get(filePath)!.get('GETQuery');
      expect(entry).not.toBeNull();
      expect(entry!.properties.length).toBe(1);
      expect(entry!.properties[0].name).toBe('page');
      expect(typeof entry!.validator).toBe('function');

      // 验证加载的校验函数能正常工作
      const result = entry!.validator({ page: 1 });
      expect(result.valid).toBe(true);

      const invalid = entry!.validator({});
      expect(invalid.valid).toBe(false);
    });

    it('null 值在往返后保持 null', async () => {
      const filePath = join(tempDir, 'health.ts');
      writeFileSync(filePath, `export function GET() { return 'ok'; }\n`);

      const entries: SchemaModuleEntry[] = [{ filePath, schemaName: 'GETQuery', typeInfo: null }];
      const allTypesMap = new Map([[filePath, new Map()]]);

      const outputPath = join(tempDir, 'faapi-schema.js');
      await writeSchemaModule(entries, allTypesMap, outputPath);

      const loaded = await readManifestFile(outputPath);

      expect(loaded.get(filePath)!.get('GETQuery')).toBeNull();
    });
  });
});
