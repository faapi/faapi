import { describe, it, expect } from 'vitest';
import { stringifyJson } from './stringifyJson';

describe('stringifyJson', () => {
  it('普通对象/数组与 JSON.stringify 完全一致', () => {
    expect(stringifyJson({ a: 1, b: 'x', c: [true, null] })).toBe(
      JSON.stringify({ a: 1, b: 'x', c: [true, null] }),
    );
    expect(stringifyJson([1, 2, 3])).toBe('[1,2,3]');
  });

  it('顶层 BigInt 转字符串', () => {
    expect(stringifyJson(123n)).toBe('"123"');
  });

  it('嵌套 BigInt 转字符串（对象字段/数组元素/深层）', () => {
    expect(stringifyJson({ id: 9007199254740993n })).toBe('{"id":"9007199254740993"}');
    expect(stringifyJson([1n, 2n])).toBe('["1","2"]');
    expect(stringifyJson({ a: { b: { c: 1n } } })).toBe('{"a":{"b":{"c":"1"}}}');
  });

  it('Date 仍序列化为 ISO 字符串（toJSON 先于 BigInt 替换，行为不变）', () => {
    expect(stringifyJson({ at: new Date('2026-01-01T00:00:00.000Z') })).toBe(
      '{"at":"2026-01-01T00:00:00.000Z"}',
    );
  });

  it('NaN/Infinity 按原生规则输出 null', () => {
    expect(stringifyJson({ x: NaN })).toBe('{"x":null}');
    expect(stringifyJson({ x: Infinity })).toBe('{"x":null}');
  });

  it('循环引用仍抛 TypeError（结构错误显式失败，不静默产出坏 JSON）', () => {
    const obj: Record<string, unknown> = { name: 'a' };
    obj['self'] = obj;
    expect(() => stringifyJson(obj)).toThrow(TypeError);
  });

  it('自定义 toJSON 返回 BigInt 也被转换', () => {
    const obj = { toJSON: () => 42n };
    expect(stringifyJson(obj)).toBe('"42"');
  });
});
