import { describe, it, expect } from 'vitest';
import { stringifyJson } from './stringifyJson';

describe('stringifyJson', () => {
  it('普通对象/数组与 JSON.stringify 完全一致', () => {
    expect(stringifyJson({ a: 1, b: 'x', c: [true, null] })).toBe(
      JSON.stringify({ a: 1, b: 'x', c: [true, null] }),
    );
    expect(stringifyJson([1, 2, 3])).toBe('[1,2,3]');
  });

  it('Date 转毫秒时间戳（嵌套字段/顶层/数组元素）', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(stringifyJson({ at: d })).toBe('{"at":1767225600000}');
    expect(stringifyJson(d)).toBe('1767225600000');
    expect(stringifyJson([d])).toBe('[1767225600000]');
  });

  it('BigInt 转字符串（顶层/嵌套字段/数组元素/深层）', () => {
    expect(stringifyJson(123n)).toBe('"123"');
    expect(stringifyJson({ id: 9007199254740993n })).toBe('{"id":"9007199254740993"}');
    expect(stringifyJson([1n, 2n])).toBe('["1","2"]');
    expect(stringifyJson({ a: { b: { c: 1n } } })).toBe('{"a":{"b":{"c":"1"}}}');
  });

  it('Map 转 entries 数组，Set 转值数组（键值/元素递归转换）', () => {
    expect(stringifyJson(new Map([['a', 1]]))).toBe('[["a",1]]');
    expect(stringifyJson({ m: new Map([['at', new Date('2026-01-01T00:00:00.000Z')]]) })).toBe(
      '{"m":[["at",1767225600000]]}',
    );
    expect(stringifyJson(new Set([1, 'x']))).toBe('[1,"x"]');
    expect(stringifyJson(new Set([new Date('2026-01-01T00:00:00.000Z')]))).toBe('[1767225600000]');
  });

  it('NaN/±Infinity 转字符串（不再静默丢成 null）', () => {
    expect(stringifyJson({ x: NaN })).toBe('{"x":"NaN"}');
    expect(stringifyJson({ x: Infinity })).toBe('{"x":"Infinity"}');
    expect(stringifyJson({ x: -Infinity })).toBe('{"x":"-Infinity"}');
  });

  it('RegExp 转 "/source/flags" 字符串', () => {
    expect(stringifyJson({ re: /ab+c/gi })).toBe('{"re":"/ab+c/gi"}');
  });

  it('undefined/function/symbol 保持原生语义（属性丢弃、数组转 null）', () => {
    expect(stringifyJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stringifyJson([undefined])).toBe('[null]');
    expect(stringifyJson({ fn: () => 1 })).toBe('{}');
    expect(stringifyJson({ [Symbol('s')]: 1, b: 2 })).toBe('{"b":2}');
  });

  it('带 toJSON 的类型保持原生行为（URL → 字符串）', () => {
    expect(stringifyJson({ url: new URL('https://faapi.dev/a') })).toBe(
      '{"url":"https://faapi.dev/a"}',
    );
  });

  it('自定义 toJSON 返回 BigInt/Date 也被转换', () => {
    expect(stringifyJson({ toJSON: () => 42n })).toBe('"42"');
    expect(stringifyJson({ toJSON: () => new Date('2026-01-01T00:00:00.000Z') })).toBe(
      '1767225600000',
    );
  });

  it('嵌套混合：Date + BigInt + Set 同一结构全部转换', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(stringifyJson({ at: d, id: 1n, tags: new Set([d]) })).toBe(
      '{"at":1767225600000,"id":"1","tags":[1767225600000]}',
    );
  });

  it('循环引用抛 TypeError（结构错误显式失败，不静默产出坏 JSON）', () => {
    const obj: Record<string, unknown> = { name: 'a' };
    obj['self'] = obj;
    expect(() => stringifyJson(obj)).toThrow(TypeError);
  });

  it('共享引用（非循环）正常序列化', () => {
    const shared = { v: 1 };
    expect(stringifyJson({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });

  it('快路径：纯 JSON 原生类型大树与慢路径输出逐字节一致', () => {
    // 快路径（needsConversion=false 直通 JSON.stringify）与重建路径的输出必须一致
    const tree = {
      str: 'x',
      num: 1.5,
      neg: -0,
      bool: false,
      nil: null,
      arr: [{ a: [1, 'two', true, null] }, []],
      nested: { deep: { deeper: { list: [{ ok: 0 }] } } },
    };
    expect(stringifyJson(tree)).toBe(JSON.stringify(tree));
  });

  it('快路径下循环引用同样抛 TypeError（检测与慢路径同语义）', () => {
    const obj: Record<string, unknown> = { list: [1, 2] };
    obj['self'] = obj;
    expect(() => stringifyJson(obj)).toThrow(TypeError);
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => stringifyJson({ arr })).toThrow(TypeError);
  });

  it('toJSON 返回含 Date 的对象走慢路径且 Date 被转换', () => {
    const wrapper = {
      toJSON: () => ({ at: new Date('2026-01-01T00:00:00.000Z'), plain: 1 }),
    };
    expect(stringifyJson({ w: wrapper })).toBe('{"w":{"at":1767225600000,"plain":1}}');
  });

  it('类实例（无 toJSON）原样序列化，快慢路径一致', () => {
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}
    }
    expect(stringifyJson({ p: new Point(1, 2) })).toBe('{"p":{"x":1,"y":2}}');
  });
});
