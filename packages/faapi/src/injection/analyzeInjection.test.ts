import { describe, it, expect } from 'vitest';
import { analyzeInjection } from './analyzeInjection';

describe('analyzeInjection', () => {
  describe('参数名识别', () => {
    it('识别 query 参数', () => {
      const code = `
        export function GET(query: Query) {
          return query;
        }
      `;
      const result = analyzeInjection(code, 'GET');
      expect(result.params).toHaveLength(1);
      expect(result.params[0].name).toBe('query');
      expect(result.params[0].type).toBe('query');
    });

    it('识别 body 参数', () => {
      const code = `
        export function POST(body: CreateUserBody) {
          return body;
        }
      `;
      const result = analyzeInjection(code, 'POST');
      expect(result.params[0].type).toBe('body');
    });

    it('识别多参数', () => {
      const code = `
        export function PUT(params: Params, body: Body, headers: Headers) {
          return { params, body, headers };
        }
      `;
      const result = analyzeInjection(code, 'PUT');
      expect(result.params).toHaveLength(3);
      expect(result.params[0].type).toBe('params');
      expect(result.params[1].type).toBe('body');
      expect(result.params[2].type).toBe('headers');
    });
  });

  describe('类型提取', () => {
    it('提取引用类型名', () => {
      const code = `
        export function GET(query: Query) {
          return query;
        }
      `;
      const result = analyzeInjection(code, 'GET');
      expect(result.params[0].typeName).toBe('Query');
    });

    it('提取内联类型', () => {
      const code = `
        export function GET(query: { page: number; pageSize: number }) {
          return query;
        }
      `;
      const result = analyzeInjection(code, 'GET');
      expect(result.params[0].schema).toBeDefined();
      expect(result.params[0].schema).toContainEqual({
        name: 'page',
        type: 'number',
        optional: false,
      });
    });
  });

  describe('边界情况', () => {
    it('无参数函数', () => {
      const code = `
        export function GET() {
          return { status: 'ok' };
        }
      `;
      const result = analyzeInjection(code, 'GET');
      expect(result.params).toHaveLength(0);
    });

    it('无类型标注', () => {
      const code = `
        export function GET(query) {
          return query;
        }
      `;
      const result = analyzeInjection(code, 'GET');
      expect(result.params[0].typeName).toBeUndefined();
      expect(result.params[0].schema).toBeUndefined();
    });

    it('目标函数不存在时返回空 params', () => {
      const code = `
        export function GET(query: Query) {
          return query;
        }
      `;
      const result = analyzeInjection(code, 'POST');
      expect(result.params).toHaveLength(0);
    });

    it('支持可选参数标注', () => {
      const code = `
        export function GET(query?: Query) {
          return query;
        }
      `;
      const result = analyzeInjection(code, 'GET');
      expect(result.params).toHaveLength(1);
      expect(result.params[0].name).toBe('query');
      expect(result.params[0].type).toBe('query');
      expect(result.params[0].typeName).toBe('Query');
    });

    it('支持默认值参数', () => {
      const code = `
        export function GET(query: Query = getDefault()) {
          return query;
        }
      `;
      const result = analyzeInjection(code, 'GET');
      expect(result.params).toHaveLength(1);
      expect(result.params[0].name).toBe('query');
      expect(result.params[0].typeName).toBe('Query');
    });

    it('识别 cookies 参数', () => {
      const code = `
        export function GET(cookies: Cookies) {
          return cookies;
        }
      `;
      const result = analyzeInjection(code, 'GET');
      expect(result.params[0].type).toBe('cookies');
    });

    it('识别 files 参数', () => {
      const code = `
        export function POST(files: Files) {
          return files;
        }
      `;
      const result = analyzeInjection(code, 'POST');
      expect(result.params[0].type).toBe('files');
    });

    it('识别 fields 参数', () => {
      const code = `
        export function POST(fields: Fields) {
          return fields;
        }
      `;
      const result = analyzeInjection(code, 'POST');
      expect(result.params[0].type).toBe('fields');
    });

    it('识别 ctx 别名参数', () => {
      const code = `
        export function GET(ctx: Context) {
          return ctx;
        }
      `;
      const result = analyzeInjection(code, 'GET');
      expect(result.params[0].name).toBe('ctx');
      expect(result.params[0].type).toBe('context');
    });

    it('未知参数名标记为 unknown', () => {
      const code = `
        export function GET(data: Data) {
          return data;
        }
      `;
      const result = analyzeInjection(code, 'GET');
      expect(result.params[0].type).toBe('unknown');
    });
  });
});
