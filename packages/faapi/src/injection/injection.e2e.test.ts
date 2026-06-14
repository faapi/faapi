import { describe, it, expect } from 'vitest';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { analyzeInjection } from './analyzeInjection';
import { resolveInjection } from './resolveInjection';
import { injectParamsAsync } from './injectParams';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/injection-test');

describe('Injection E2E', () => {
  describe('resolveInjection - 运行时参数分析', () => {
    it('识别 query 参数', async () => {
      const handlerPath = path.join(FIXTURES_DIR, 'api/user/handler.ts');

      // 动态加载 handler
      const module = await import(handlerPath);
      const handler = module.GET;

      const result = resolveInjection(handler);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('query');
      expect(result[0].type).toBe('query');
      // 注意：运行时类型信息可能丢失，hasType 可能是 false
    });

    it('识别 body 参数', async () => {
      const handlerPath = path.join(FIXTURES_DIR, 'api/user/handler.ts');
      const module = await import(handlerPath);
      const handler = module.POST;

      const result = resolveInjection(handler);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('body');
      expect(result[0].type).toBe('body');
    });

    it('识别多参数（顺序不固定）', async () => {
      const handlerPath = path.join(FIXTURES_DIR, 'api/auth/handler.ts');
      const module = await import(handlerPath);
      const handler = module.GET;

      const result = resolveInjection(handler);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('headers');
      expect(result[0].type).toBe('headers');
      expect(result[1].name).toBe('query');
      expect(result[1].type).toBe('query');
    });

    it('识别 context 参数', async () => {
      const handlerPath = path.join(FIXTURES_DIR, 'api/auth/handler.ts');
      const module = await import(handlerPath);
      const handler = module.POST;

      const result = resolveInjection(handler);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('context');
      expect(result[0].type).toBe('context');
    });
  });

  describe('analyzeInjection - AST 分析', () => {
    it('分析 query 参数并提取类型', async () => {
      const handlerPath = path.join(FIXTURES_DIR, 'api/user/handler.ts');
      const code = await fs.readFile(handlerPath, 'utf-8');

      const result = analyzeInjection(code, 'GET');

      expect(result.params).toHaveLength(1);
      expect(result.params[0].name).toBe('query');
      expect(result.params[0].type).toBe('query');
      expect(result.params[0].typeName).toBe('Query');
    });

    it('分析 body 参数', async () => {
      const handlerPath = path.join(FIXTURES_DIR, 'api/user/handler.ts');
      const code = await fs.readFile(handlerPath, 'utf-8');

      const result = analyzeInjection(code, 'POST');

      expect(result.params).toHaveLength(1);
      expect(result.params[0].type).toBe('body');
      expect(result.params[0].typeName).toBe('CreateUserBody');
    });

    it('分析多参数', async () => {
      const handlerPath = path.join(FIXTURES_DIR, 'api/auth/handler.ts');
      const code = await fs.readFile(handlerPath, 'utf-8');

      const result = analyzeInjection(code, 'GET');

      expect(result.params).toHaveLength(2);
      expect(result.params[0].type).toBe('headers');
      expect(result.params[1].type).toBe('query');
    });
  });

  describe('injectParams - 参数注入执行', () => {
    it('注入 query 参数', async () => {
      const handlerPath = path.join(FIXTURES_DIR, 'api/user/handler.ts');
      const module = await import(handlerPath);
      const handler = module.GET;

      // 模拟 context（注入逻辑只读取 request/params/query/headers/method/path，其余字段提供空实现以满足类型）
      const url = new URL('http://localhost:3000/api/user?page=2&pageSize=20');
      const ctx = {
        request: new Request(url),
        params: {},
        query: url.searchParams,
        headers: new Headers(),
        method: 'GET',
        path: '/api/user',
      } as any;

      const result = await injectParamsAsync(handler, ctx);

      expect(result).toEqual({
        injected: 'query',
        page: '2',
        pageSize: '20',
      });
    });

    it('注入 headers 和 query（顺序不固定）', async () => {
      const handlerPath = path.join(FIXTURES_DIR, 'api/auth/handler.ts');
      const module = await import(handlerPath);
      const handler = module.GET;

      const url = new URL('http://localhost:3000/api/auth?fields=name,email');
      const ctx = {
        request: new Request(url, {
          headers: { authorization: 'Bearer token123' },
        }),
        params: {},
        query: url.searchParams,
        headers: new Headers({ authorization: 'Bearer token123' }),
        method: 'GET',
        path: '/api/auth',
      } as any;

      const result = await injectParamsAsync(handler, ctx);

      expect(result).toMatchObject({
        injected: 'headers+query',
        fields: 'name,email',
      });
      // headers 注入的是 Headers 对象，检查 hasAuth
      expect((result as { hasAuth: boolean }).hasAuth).toBe(true);
    });

    it('注入 context', async () => {
      const handlerPath = path.join(FIXTURES_DIR, 'api/auth/handler.ts');
      const module = await import(handlerPath);
      const handler = module.POST;

      const url = new URL('http://localhost:3000/api/auth/context');
      const ctx = {
        request: new Request(url),
        params: {},
        query: url.searchParams,
        headers: new Headers(),
        method: 'POST',
        path: '/api/auth/context',
      } as any;

      const result = await injectParamsAsync(handler, ctx);

      expect(result).toEqual({
        injected: 'context',
        method: 'POST',
        path: '/api/auth/context',
      });
    });
  });

  describe('完整流程：扫描 → 分析 → 注入', () => {
    it('扫描路由并分析所有 handler', async () => {
      const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts'], 'app');
      const sorted = sortRoutes(routes);

      expect(sorted.length).toBeGreaterThan(0);

      // 分析每个路由
      for (const route of sorted) {
        // route.filePath 是相对路径，需要拼接绝对路径
        const absolutePath = path.join(FIXTURES_DIR, route.filePath);
        const code = await fs.readFile(absolutePath, 'utf-8');
        const meta = analyzeInjection(code, route.method);

        expect(meta).toHaveProperty('params');
        expect(Array.isArray(meta.params)).toBe(true);
      }
    });
  });
});
