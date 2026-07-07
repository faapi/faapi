import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateSchemaFiles,
  generateSchemaFileSource,
  getSchemaOutputPath,
} from './generateSchemaFiles';
import { createProgram } from '../ast/createProgram';
import { extractAllTypes } from '../ast/extractHandlerTypes';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import type { RouteManifest } from '../router/routeTypes';
import type { RouteSchemaSource } from './collectRouteSchemaSources';

/**
 * generateSchemaFiles 测试：从路由清单为每个 handler 生成 zod.js
 *
 * 覆盖：
 * - generateSchemaFileSource：生成单个 handler 文件的 zod.js 源码
 * - generateSchemaFiles：批量生成 zod.js 到 dist
 * - getSchemaOutputPath：源码路径 → 产物 zod.js 路径
 * - 端到端：生成的 zod.js 可被 import 并用于 zod safeParse
 */
describe('generateSchemaFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-gen-schema-files-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * 构造单文件路由清单（urlPath 作为 schema key）
   */
  function singleFileRoutes(
    filePath: string,
    methods: string[],
    urlPath = '/api/test',
  ): RouteManifest {
    return methods.map((method) => ({
      method: method as any,
      urlPath,
      filePath,
      paramNames: [],
      isDynamic: false,
    }));
  }

  describe('getSchemaOutputPath', () => {
    it('打平 src 前缀（src/api/hello/handler.ts → dist/api/hello/zod.js）', () => {
      const result = getSchemaOutputPath('src/api/hello/handler.ts', 'dist', '/root');
      expect(result).toBe(join('/root', 'dist', 'api', 'hello', 'zod.js'));
    });

    it('dev 模式输出到 .faapi/dev', () => {
      const result = getSchemaOutputPath('src/api/user/handler.ts', '.faapi/dev', '/root');
      expect(result).toBe(join('/root', '.faapi', 'dev', 'api', 'user', 'zod.js'));
    });
  });

  describe('generateSchemaFileSource', () => {
    /**
     * 从源码提取类型信息并构造 RouteSchemaSource（用于单元测试 generateSchemaFileSource）
     */
    function makeSources(
      file: string,
      methods: string[],
      urlPath = '/api/test',
    ): RouteSchemaSource[] {
      const program = createProgram(file);
      const allTypes = extractAllTypes(program, file);
      const sources: RouteSchemaSource[] = [];
      // 这里只取方法对应的 schemaName，typeInfo 实际由 collectRouteSchemaSources 提取
      // 单元测试中简化：直接从 allTypes 取约定名
      const schemaNames = methods.map((m) => `${m.toUpperCase()}Query`);
      for (const schemaName of schemaNames) {
        const typeInfo = allTypes.get(schemaName) ?? null;
        sources.push({ urlPath, filePath: file, schemaName, typeInfo });
      }
      return sources;
    }

    it('生成 zod.js 源码（含 import 和 export const Schema）', () => {
      const file = join(tempDir, 'user.ts');
      writeFileSync(
        file,
        `export interface GETQuery {
  page: number;
  name?: string;
}
export function GET(query: GETQuery) { return query; }
`,
      );

      const sources = makeSources(file, ['GET']);
      const allTypes = extractAllTypes(createProgram(file), file);
      const source = generateSchemaFileSource(sources, allTypes, '../../faapi-helpers.js');

      expect(source).toContain("import { z } from 'zod'");
      expect(source).toContain('export const GETQuerySchema');
      // coerce 内联到 schema 后不再导出 Properties
      expect(source).not.toContain('export const GETQueryProperties');
      expect(source).toContain('z.number()');
      expect(source).toContain('z.string().optional()');
    });

    it('多方法生成多个 schema 导出', () => {
      const file = join(tempDir, 'user.ts');
      writeFileSync(
        file,
        `export interface GETQuery { id: string; }
export interface POSTBody { name: string; email: string; }
export function GET(query: GETQuery) { return query; }
export function POST(body: POSTBody) { return body; }
`,
      );

      // 简化：手动构造 sources
      const program = createProgram(file);
      const allTypes = extractAllTypes(program, file);
      const sources: RouteSchemaSource[] = [
        {
          urlPath: '/api/test',
          filePath: file,
          schemaName: 'GETQuery',
          typeInfo: allTypes.get('GETQuery') ?? null,
        },
        {
          urlPath: '/api/test',
          filePath: file,
          schemaName: 'POSTBody',
          typeInfo: allTypes.get('POSTBody') ?? null,
        },
      ];

      const source = generateSchemaFileSource(sources, allTypes, '../../faapi-helpers.js');

      expect(source).toContain('export const GETQuerySchema');
      expect(source).toContain('export const POSTBodySchema');
      // coerce 内联后不再导出 Properties
      expect(source).not.toContain('export const GETQueryProperties');
      expect(source).not.toContain('export const POSTBodyProperties');
    });

    it('无类型声明时不导出对应 schema', () => {
      const file = join(tempDir, 'health.ts');
      writeFileSync(file, `export function GET() { return 'ok'; }\n`);

      const sources: RouteSchemaSource[] = [
        { urlPath: '/api/test', filePath: file, schemaName: 'GETQuery', typeInfo: null },
      ];
      const allTypes = extractAllTypes(createProgram(file), file);
      const source = generateSchemaFileSource(sources, allTypes, '../../faapi-helpers.js');

      // 仍含 import 语句
      expect(source).toContain("import { z } from 'zod'");
      // 不导出 GETQuerySchema
      expect(source).not.toContain('export const GETQuerySchema');
      expect(source).not.toContain('export const GETQueryProperties');
    });

    it('循环引用用 z.lazy', () => {
      const file = join(tempDir, 'tree.ts');
      writeFileSync(
        file,
        `export interface GETQuery {
  tree: TreeNode;
}
export interface TreeNode {
  value: number;
  children?: TreeNode[];
}
export function GET(query: GETQuery) { return query; }
`,
      );

      const program = createProgram(file);
      const allTypes = extractAllTypes(program, file);
      const sources: RouteSchemaSource[] = [
        {
          urlPath: '/api/test',
          filePath: file,
          schemaName: 'GETQuery',
          typeInfo: allTypes.get('GETQuery') ?? null,
        },
      ];

      const source = generateSchemaFileSource(sources, allTypes, '../../faapi-helpers.js');
      // TreeNode 含自引用，应使用 z.lazy
      expect(source).toContain('z.lazy');
      expect(source).toContain('TreeNodeSchema');
    });

    it('query schema 含 preprocess（coerce=true），body schema 不含 preprocess（coerce=false）', () => {
      const file = join(tempDir, 'user.ts');
      writeFileSync(
        file,
        `export interface GETQuery {
  page: number;
  active?: boolean;
}
export interface POSTBody {
  count: number;
  active: boolean;
}
export function GET(query: GETQuery) { return query; }
export function POST(body: POSTBody) { return body; }
`,
      );

      const program = createProgram(file);
      const allTypes = extractAllTypes(program, file);
      const sources: RouteSchemaSource[] = [
        {
          urlPath: '/api/test',
          filePath: file,
          schemaName: 'GETQuery',
          typeInfo: allTypes.get('GETQuery') ?? null,
        },
        {
          urlPath: '/api/test',
          filePath: file,
          schemaName: 'POSTBody',
          typeInfo: allTypes.get('POSTBody') ?? null,
        },
      ];

      const source = generateSchemaFileSource(sources, allTypes, '../../faapi-helpers.js');

      // 两个 schema 都存在
      expect(source).toContain('export const GETQuerySchema');
      expect(source).toContain('export const POSTBodySchema');

      // 通过定位各 schema 的导出片段判断是否含 preprocess
      // GETQuery 片段（query：coerce=true，number/boolean 字段应含 z.preprocess）
      const getQueryStart = source.indexOf('export const GETQuerySchema');
      const postBodyStart = source.indexOf('export const POSTBodySchema');
      const getQueryFragment = source.slice(getQueryStart, postBodyStart);
      expect(getQueryFragment).toContain('z.preprocess');

      // POSTBody 片段（body：coerce=false，不应含 z.preprocess）
      const postBodyFragment = source.slice(postBodyStart);
      expect(postBodyFragment).not.toContain('z.preprocess');
    });

    it('params schema 含 preprocess（schemaName 以 Params 结尾也 coerce=true）', () => {
      const file = join(tempDir, 'user.ts');
      writeFileSync(
        file,
        `export interface GETParams {
  id: number;
}
export function GET(params: GETParams) { return params; }
`,
      );

      const program = createProgram(file);
      const allTypes = extractAllTypes(program, file);
      const sources: RouteSchemaSource[] = [
        {
          urlPath: '/api/test/:id',
          filePath: file,
          schemaName: 'GETParams',
          typeInfo: allTypes.get('GETParams') ?? null,
        },
      ];

      const source = generateSchemaFileSource(sources, allTypes, '../../faapi-helpers.js');
      expect(source).toContain('export const GETParamsSchema');
      expect(source).toContain('z.preprocess');
    });

    it('form 注入的 schema 名为 POSTBody 但 coerce=true（显式覆盖正则推断）', () => {
      // 模拟 collectRouteSchemaSources 对 form 声明的处理结果：
      // schemaName 仍为 POSTBody（共享 body 的 schema key），但 coerce=true 显式标记
      const file = join(tempDir, 'login.ts');
      writeFileSync(
        file,
        `export interface LoginForm {
  username: string;
  age: number;
  remember?: boolean;
}
export function POST(form: LoginForm) { return form; }
`,
      );

      const program = createProgram(file);
      const allTypes = extractAllTypes(program, file);
      const sources: RouteSchemaSource[] = [
        {
          urlPath: '/api/login',
          filePath: file,
          schemaName: 'POSTBody',
          typeInfo: allTypes.get('LoginForm') ?? null,
          coerce: true,
        },
      ];

      const source = generateSchemaFileSource(sources, allTypes, '../../faapi-helpers.js');

      // schema 名仍为 POSTBodySchema（运行时 validateInput 用此 key 查找）
      expect(source).toContain('export const POSTBodySchema');
      // form 的 number/boolean 字段需 z.preprocess（coerce=true）
      expect(source).toContain('z.preprocess');
      // 引用 faapi-helpers.js 的 coerceNumber/coerceBoolean
      expect(source).toContain("from '../../faapi-helpers.js'");
    });
  });

  describe('generateSchemaFiles', () => {
    it('为每个 handler 生成 zod.js 文件', async () => {
      const filePath = join(tempDir, 'src', 'api', 'user', 'handler.ts');
      mkdirSync(join(tempDir, 'src', 'api', 'user'), { recursive: true });
      writeFileSync(
        filePath,
        `export interface GETQuery {
  page: number;
  name?: string;
}
export function GET(query: GETQuery) { return query; }
`,
      );

      const routes = singleFileRoutes('src/api/user/handler.ts', ['GET'], '/api/user');
      const dist = join(tempDir, 'dist');
      await generateSchemaFiles(routes, tempDir, dist);

      const expectedPath = join(dist, 'api', 'user', 'zod.js');
      expect(existsSync(expectedPath)).toBe(true);

      const content = readFileSync(expectedPath, 'utf-8');
      expect(content).toContain('export const GETQuerySchema');
      // coerce 内联后不再导出 Properties
      expect(content).not.toContain('export const GETQueryProperties');
    });

    it('多方法合并到同一 zod.js', async () => {
      const filePath = join(tempDir, 'src', 'api', 'user', 'handler.ts');
      mkdirSync(join(tempDir, 'src', 'api', 'user'), { recursive: true });
      writeFileSync(
        filePath,
        `export interface GETQuery { id: string; }
export interface POSTBody { name: string; email: string; }
export function GET(query: GETQuery) { return query; }
export function POST(body: POSTBody) { return body; }
`,
      );

      const routes: RouteManifest = [
        {
          method: 'GET',
          urlPath: '/api/user',
          filePath: 'src/api/user/handler.ts',
          paramNames: [],
          isDynamic: false,
        },
        {
          method: 'POST',
          urlPath: '/api/user',
          filePath: 'src/api/user/handler.ts',
          paramNames: [],
          isDynamic: false,
        },
      ];
      const dist = join(tempDir, 'dist');
      await generateSchemaFiles(routes, tempDir, dist);

      const schemaPath = join(dist, 'api', 'user', 'zod.js');
      const content = readFileSync(schemaPath, 'utf-8');
      expect(content).toContain('export const GETQuerySchema');
      expect(content).toContain('export const POSTBodySchema');
    });

    it('多 handler 文件生成多个 zod.js', async () => {
      mkdirSync(join(tempDir, 'src', 'api', 'user'), { recursive: true });
      mkdirSync(join(tempDir, 'src', 'api', 'health'), { recursive: true });
      writeFileSync(
        join(tempDir, 'src', 'api', 'user', 'handler.ts'),
        `export interface GETQuery { page: number; }
export function GET(query: GETQuery) { return query; }
`,
      );
      writeFileSync(
        join(tempDir, 'src', 'api', 'health', 'handler.ts'),
        `export function GET() { return 'ok'; }
`,
      );

      const routes: RouteManifest = [
        {
          method: 'GET',
          urlPath: '/api/user',
          filePath: 'src/api/user/handler.ts',
          paramNames: [],
          isDynamic: false,
        },
        {
          method: 'GET',
          urlPath: '/api/health',
          filePath: 'src/api/health/handler.ts',
          paramNames: [],
          isDynamic: false,
        },
      ];
      const dist = join(tempDir, 'dist');
      await generateSchemaFiles(routes, tempDir, dist);

      expect(existsSync(join(dist, 'api', 'user', 'zod.js'))).toBe(true);
      expect(existsSync(join(dist, 'api', 'health', 'zod.js'))).toBe(true);

      const userContent = readFileSync(join(dist, 'api', 'user', 'zod.js'), 'utf-8');
      expect(userContent).toContain('export const GETQuerySchema');

      const healthContent = readFileSync(join(dist, 'api', 'health', 'zod.js'), 'utf-8');
      // 无类型声明，不导出 Schema
      expect(healthContent).toContain("import { z } from 'zod'");
      expect(healthContent).not.toContain('export const GETQuerySchema');
    });

    it('生成的 zod.js 可被 import 并用于 zod safeParse', async () => {
      const filePath = join(tempDir, 'src', 'api', 'user', 'handler.ts');
      mkdirSync(join(tempDir, 'src', 'api', 'user'), { recursive: true });
      writeFileSync(
        filePath,
        `export interface GETQuery {
  page: number;
  name?: string;
}
export function GET(query: GETQuery) { return query; }
`,
      );

      const routes = singleFileRoutes('src/api/user/handler.ts', ['GET'], '/api/user');
      const dist = join(tempDir, 'dist');
      await generateSchemaFiles(routes, tempDir, dist);

      const schemaPath = join(dist, 'api', 'user', 'zod.js');
      const mod = (await importWithCacheBust(schemaPath)) as {
        GETQuerySchema: { safeParse: (v: unknown) => { success: boolean } };
        [key: string]: unknown;
      };

      expect(mod.GETQuerySchema).toBeDefined();
      // coerce 内联后不再导出 Properties
      expect(mod.GETQueryProperties).toBeUndefined();

      // 校验正确输入
      const ok = mod.GETQuerySchema.safeParse({ page: 1 });
      expect(ok.success).toBe(true);

      // 校验缺必填字段
      const missing = mod.GETQuerySchema.safeParse({});
      expect(missing.success).toBe(false);

      // query schema coerce=true："1" 会被 preprocess 转为 1 后通过
      const coerced = mod.GETQuerySchema.safeParse({ page: '1' });
      expect(coerced.success).toBe(true);

      // 校验类型错误（"abc" 无法 coerce，保留原值后 zod 报 invalid_type）
      const wrongType = mod.GETQuerySchema.safeParse({ page: 'abc' });
      expect(wrongType.success).toBe(false);
    });

    it('生成的 zod.js 可处理循环引用', async () => {
      const filePath = join(tempDir, 'src', 'api', 'tree', 'handler.ts');
      mkdirSync(join(tempDir, 'src', 'api', 'tree'), { recursive: true });
      writeFileSync(
        filePath,
        `export interface GETQuery {
  tree: TreeNode;
}
export interface TreeNode {
  value: number;
  children?: TreeNode[];
}
export function GET(query: GETQuery) { return query; }
`,
      );

      const routes = singleFileRoutes('src/api/tree/handler.ts', ['GET'], '/api/tree');
      const dist = join(tempDir, 'dist');
      await generateSchemaFiles(routes, tempDir, dist);

      const schemaPath = join(dist, 'api', 'tree', 'zod.js');
      const mod = (await importWithCacheBust(schemaPath)) as {
        GETQuerySchema: { safeParse: (v: unknown) => { success: boolean } };
      };

      // 嵌套数据
      const ok = mod.GETQuerySchema.safeParse({
        tree: {
          value: 1,
          children: [{ value: 2 }, { value: 3, children: [{ value: 4 }] }],
        },
      });
      expect(ok.success).toBe(true);

      // 类型错误（query schema coerce=true："1" 会被转为 1，需用无法 coerce 的值）
      const wrong = mod.GETQuerySchema.safeParse({ tree: { value: 'abc' } });
      expect(wrong.success).toBe(false);
    });

    it('无路由时不报错', async () => {
      const dist = join(tempDir, 'dist');
      await generateSchemaFiles([], tempDir, dist);
      // dist 可能不存在（无文件需要写）
      expect(existsSync(dist)).toBe(false);
    });

    it('dev 模式输出到 .faapi/dev', async () => {
      const filePath = join(tempDir, 'src', 'api', 'user', 'handler.ts');
      mkdirSync(join(tempDir, 'src', 'api', 'user'), { recursive: true });
      writeFileSync(
        filePath,
        `export interface GETQuery { page: number; }
export function GET(query: GETQuery) { return query; }
`,
      );

      const routes = singleFileRoutes('src/api/user/handler.ts', ['GET'], '/api/user');
      const dist = join(tempDir, '.faapi', 'dev');
      await generateSchemaFiles(routes, tempDir, dist);

      expect(existsSync(join(dist, 'api', 'user', 'zod.js'))).toBe(true);
    });

    it('含 coerce schema 时生成 faapi-helpers.js 并通过 import 复用', async () => {
      const filePath = join(tempDir, 'src', 'api', 'user', 'handler.ts');
      mkdirSync(join(tempDir, 'src', 'api', 'user'), { recursive: true });
      writeFileSync(
        filePath,
        `export interface GETQuery { page: number; active?: boolean; }
export function GET(query: GETQuery) { return query; }
`,
      );

      const routes = singleFileRoutes('src/api/user/handler.ts', ['GET'], '/api/user');
      const dist = join(tempDir, 'dist');
      await generateSchemaFiles(routes, tempDir, dist);

      // faapi-helpers.js 生成在 dist 根部
      const helpersPath = join(dist, 'faapi-helpers.js');
      expect(existsSync(helpersPath)).toBe(true);
      const helpersContent = readFileSync(helpersPath, 'utf-8');
      expect(helpersContent).toContain('export const coerceNumber');
      expect(helpersContent).toContain('export const coerceBoolean');

      // zod.js 通过相对路径 import helpers
      const zodPath = join(dist, 'api', 'user', 'zod.js');
      const zodContent = readFileSync(zodPath, 'utf-8');
      // zod.js 在 dist/api/user/，helpers 在 dist/，相对路径为 ../../faapi-helpers.js
      expect(zodContent).toContain("from '../../faapi-helpers.js'");
      // zod.js 不再内联 coerceNumber/coerceBoolean 函数体
      expect(zodContent).not.toContain('typeof v === "string"');
    });

    it('无 coerce schema 时不生成 faapi-helpers.js', async () => {
      const filePath = join(tempDir, 'src', 'api', 'user', 'handler.ts');
      mkdirSync(join(tempDir, 'src', 'api', 'user'), { recursive: true });
      writeFileSync(
        filePath,
        `export interface POSTBody { name: string; }
export function POST(body: POSTBody) { return body; }
`,
      );

      const routes: RouteManifest = [
        {
          method: 'POST',
          urlPath: '/api/user',
          filePath: 'src/api/user/handler.ts',
          paramNames: [],
          isDynamic: false,
        },
      ];
      const dist = join(tempDir, 'dist');
      await generateSchemaFiles(routes, tempDir, dist);

      // 无 coerce schema（POSTBody 不以 Query/Params 结尾），不生成 helpers
      expect(existsSync(join(dist, 'faapi-helpers.js'))).toBe(false);

      const zodPath = join(dist, 'api', 'user', 'zod.js');
      const zodContent = readFileSync(zodPath, 'utf-8');
      expect(zodContent).not.toContain('faapi-helpers.js');
    });

    it('handler 声明 form 时端到端生成 POSTBodySchema（coerce=true，可 safeParse form-urlencoded 值）', async () => {
      const filePath = join(tempDir, 'src', 'api', 'login', 'handler.ts');
      mkdirSync(join(tempDir, 'src', 'api', 'login'), { recursive: true });
      writeFileSync(
        filePath,
        `export interface LoginForm {
  username: string;
  age: number;
  remember?: boolean;
}
export function POST(form: LoginForm) { return form; }
`,
      );

      const routes: RouteManifest = [
        {
          method: 'POST',
          urlPath: '/api/login',
          filePath: 'src/api/login/handler.ts',
          paramNames: [],
          isDynamic: false,
        },
      ];
      const dist = join(tempDir, 'dist');
      await generateSchemaFiles(routes, tempDir, dist);

      const schemaPath = join(dist, 'api', 'login', 'zod.js');
      const content = readFileSync(schemaPath, 'utf-8');
      // schema 名为 POSTBodySchema（运行时 validateInput 用此 key 查找）
      expect(content).toContain('export const POSTBodySchema');
      // coerce=true：含 z.preprocess
      expect(content).toContain('z.preprocess');
      // 因含 coerce schema，应生成 faapi-helpers.js
      expect(existsSync(join(dist, 'faapi-helpers.js'))).toBe(true);

      // 端到端 safeParse：form-urlencoded 值（string）能被 coerce 转换通过
      const mod = (await importWithCacheBust(schemaPath)) as {
        POSTBodySchema: { safeParse: (v: unknown) => { success: boolean } };
      };
      expect(mod.POSTBodySchema).toBeDefined();

      // form 值均为 string：username=alice&age=30&remember=true
      const ok = mod.POSTBodySchema.safeParse({
        username: 'alice',
        age: '30', // string → number via coerce
        remember: 'true', // string → boolean via coerce
      });
      expect(ok.success).toBe(true);

      // 缺必填字段
      const missing = mod.POSTBodySchema.safeParse({ age: '30' });
      expect(missing.success).toBe(false);

      // 类型错误（"abc" 无法 coerce 为 number）
      const wrongType = mod.POSTBodySchema.safeParse({
        username: 'alice',
        age: 'abc',
      });
      expect(wrongType.success).toBe(false);
    });
  });
});
