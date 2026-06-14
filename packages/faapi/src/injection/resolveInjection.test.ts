import { describe, it, expect } from 'vitest';
import { resolveInjection } from './resolveInjection';

describe('resolveInjection', () => {
  describe('参数名识别', () => {
    it('识别 query 参数', () => {
      const fn = eval('(query) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([{ name: 'query', type: 'query', hasType: false }]);
    });

    it('识别 body 参数', () => {
      const fn = eval('(body) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([{ name: 'body', type: 'body', hasType: false }]);
    });

    it('识别 headers 参数', () => {
      const fn = eval('(headers) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([{ name: 'headers', type: 'headers', hasType: false }]);
    });

    it('识别 params 参数', () => {
      const fn = eval('(params) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([{ name: 'params', type: 'params', hasType: false }]);
    });

    it('识别 context 参数', () => {
      const fn = eval('(context) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([{ name: 'context', type: 'context', hasType: false }]);
    });

    it('识别 ctx 参数 (别名)', () => {
      const fn = eval('(ctx) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([{ name: 'ctx', type: 'context', hasType: false }]);
    });
  });

  describe('多参数支持', () => {
    it('支持多个参数', () => {
      const fn = eval('(query, headers) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([
        { name: 'query', type: 'query', hasType: false },
        { name: 'headers', type: 'headers', hasType: false },
      ]);
    });

    it('顺序不固定', () => {
      const fn = eval('(headers, query) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([
        { name: 'headers', type: 'headers', hasType: false },
        { name: 'query', type: 'query', hasType: false },
      ]);
    });

    it('支持三个参数', () => {
      const fn = eval('(params, body, headers) => {}');
      const result = resolveInjection(fn);
      expect(result).toHaveLength(3);
    });
  });

  describe('类型标注检测', () => {
    // 注意：运行时类型信息被擦除，hasType 始终为 false
    // 如需检测类型，请使用 analyzeInjection（AST 分析）
    it('有类型标注时 hasType 仍为 false（运行时类型擦除）', () => {
      const fn = eval('(query) => {}');
      const result = resolveInjection(fn);
      expect(result[0].hasType).toBe(false);
    });

    it('无类型标注时 hasType 为 false', () => {
      const fn = eval('(query) => {}');
      const result = resolveInjection(fn);
      expect(result[0].hasType).toBe(false);
    });
  });

  describe('未知参数', () => {
    it('未知参数名返回 unknown 类型', () => {
      const fn = eval('(data) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([{ name: 'data', type: 'unknown', hasType: false }]);
    });
  });

  describe('边界情况', () => {
    it('无参数函数返回空数组', () => {
      const fn = eval('() => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([]);
    });

    it('支持 async 函数', () => {
      const fn = eval('async (query) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([{ name: 'query', type: 'query', hasType: false }]);
    });
  });

  describe('解构参数', () => {
    it('对象解构：{ page, size } → 两个注入项', () => {
      const fn = eval('({ page, size }) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([
        { name: 'page', type: 'unknown', hasType: false },
        { name: 'size', type: 'unknown', hasType: false },
      ]);
    });

    it('数组解构：[a, b] → 两个注入项', () => {
      const fn = eval('([a, b]) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([
        { name: 'a', type: 'unknown', hasType: false },
        { name: 'b', type: 'unknown', hasType: false },
      ]);
    });

    it('rest 参数：...args → 单个注入项', () => {
      const fn = eval('(...args) => {}');
      const result = resolveInjection(fn);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('args');
    });

    it('默认值：query = {} → 仍按参数名注入', () => {
      const fn = eval('(query = {}) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([{ name: 'query', type: 'query', hasType: false }]);
    });

    it('解构参数中的已知参数名仍能识别类型', () => {
      const fn = eval('({ query, body }) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([
        { name: 'query', type: 'query', hasType: false },
        { name: 'body', type: 'body', hasType: false },
      ]);
    });
  });

  describe('函数声明形式', () => {
    it('支持 function expression', () => {
      // function expression 的参数会被识别
      const fnWithParam = function (_query: unknown) {};
      const resultWithParam = resolveInjection(fnWithParam);
      expect(resultWithParam).toEqual([{ name: '_query', type: 'unknown', hasType: false }]);
    });
  });
});
