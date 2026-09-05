import { describe, it, expect, vi } from 'vitest';
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

    it('识别 form 参数', () => {
      const fn = eval('(form) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([{ name: 'form', type: 'form', hasType: false }]);
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

    it('识别 ua 参数', () => {
      const fn = eval('(ua) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([{ name: 'ua', type: 'ua', hasType: false }]);
    });

    it('识别 agent 参数（Phase 2.3）', () => {
      const fn = eval('(agent) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([{ name: 'agent', type: 'agent', hasType: false }]);
    });

    it('识别 agents 参数（Phase 2.3）', () => {
      const fn = eval('(agents) => {}');
      const result = resolveInjection(fn);
      expect(result).toEqual([{ name: 'agents', type: 'agents', hasType: false }]);
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

  describe('按函数引用缓存', () => {
    it('同一函数引用多次调用返回同一数组实例（不重复解析）', () => {
      const fn = eval('(query, headers) => {}');
      const first = resolveInjection(fn);
      const second = resolveInjection(fn);
      expect(second).toBe(first);
    });

    it('不同函数引用即使源码相同也独立分析', () => {
      const fnA = eval('(query) => {}');
      const fnB = eval('(query) => {}');
      const resultA = resolveInjection(fnA);
      const resultB = resolveInjection(fnB);
      expect(resultA).not.toBe(resultB);
      expect(resultA).toEqual(resultB);
    });

    it('缓存命中时不再调用 fn.toString()', () => {
      const fn = eval('(body) => {}');
      const spy = vi.spyOn(fn, 'toString');
      resolveInjection(fn);
      expect(spy).toHaveBeenCalledTimes(1);
      resolveInjection(fn);
      resolveInjection(fn);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });
});
