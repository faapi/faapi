import { describe, it, expect } from 'vitest';
import { coerceInput } from './coerceInput';
import type { PropertyType } from '../ast/resolveTypeNode';

describe('coerceInput', () => {
  it('string → number 转换成功', () => {
    const properties: PropertyType[] = [
      { name: 'page', type: { kind: 'number' }, optional: false },
      { name: 'pageSize', type: { kind: 'number' }, optional: false },
    ];
    const result = coerceInput({ page: '1', pageSize: '20' }, properties);
    expect(result.issues).toEqual([]);
    expect(result.data).toEqual({ page: 1, pageSize: 20 });
  });

  it('string → number 转换失败（NaN）', () => {
    const properties: PropertyType[] = [
      { name: 'page', type: { kind: 'number' }, optional: false },
    ];
    const result = coerceInput({ page: 'abc' }, properties);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].path).toBe('page');
    expect(result.issues[0].message).toContain('无法将 "abc" 转为 number');
  });

  it('string → boolean 转换成功（true/1）', () => {
    const properties: PropertyType[] = [
      { name: 'active', type: { kind: 'boolean' }, optional: false },
      { name: 'verified', type: { kind: 'boolean' }, optional: false },
    ];
    const result = coerceInput({ active: 'true', verified: '1' }, properties);
    expect(result.issues).toEqual([]);
    expect(result.data).toEqual({ active: true, verified: true });
  });

  it('string → boolean 转换成功（false/0）', () => {
    const properties: PropertyType[] = [
      { name: 'active', type: { kind: 'boolean' }, optional: false },
      { name: 'verified', type: { kind: 'boolean' }, optional: false },
    ];
    const result = coerceInput({ active: 'false', verified: '0' }, properties);
    expect(result.issues).toEqual([]);
    expect(result.data).toEqual({ active: false, verified: false });
  });

  it('string → boolean 转换失败', () => {
    const properties: PropertyType[] = [
      { name: 'active', type: { kind: 'boolean' }, optional: false },
    ];
    const result = coerceInput({ active: 'yes' }, properties);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].path).toBe('active');
    expect(result.issues[0].message).toContain('无法将 "yes" 转为 boolean');
  });

  it('string → string 不转换', () => {
    const properties: PropertyType[] = [
      { name: 'name', type: { kind: 'string' }, optional: false },
    ];
    const result = coerceInput({ name: 'alice' }, properties);
    expect(result.issues).toEqual([]);
    expect(result.data).toEqual({ name: 'alice' });
  });

  it('已经是目标类型的不转换', () => {
    const properties: PropertyType[] = [
      { name: 'page', type: { kind: 'number' }, optional: false },
      { name: 'active', type: { kind: 'boolean' }, optional: false },
    ];
    const result = coerceInput({ page: 1, active: true }, properties);
    expect(result.issues).toEqual([]);
    expect(result.data).toEqual({ page: 1, active: true });
  });

  it('不存在的可选字段不转换', () => {
    const properties: PropertyType[] = [{ name: 'page', type: { kind: 'number' }, optional: true }];
    const result = coerceInput({}, properties);
    expect(result.issues).toEqual([]);
    expect(result.data).toEqual({});
  });

  it('unknown 类型不转换', () => {
    const properties: PropertyType[] = [
      { name: 'data', type: { kind: 'unknown' }, optional: false },
    ];
    const result = coerceInput({ data: 'anything' }, properties);
    expect(result.issues).toEqual([]);
    expect(result.data).toEqual({ data: 'anything' });
  });

  it('混合类型部分转换失败', () => {
    const properties: PropertyType[] = [
      { name: 'page', type: { kind: 'number' }, optional: false },
      { name: 'active', type: { kind: 'boolean' }, optional: false },
      { name: 'name', type: { kind: 'string' }, optional: false },
    ];
    const result = coerceInput({ page: 'abc', active: 'yes', name: 'test' }, properties);
    expect(result.issues).toHaveLength(2);
    expect(result.data.name).toBe('test');
  });

  it('number 类型空字符串转换失败', () => {
    const properties: PropertyType[] = [
      { name: 'page', type: { kind: 'number' }, optional: false },
    ];
    const result = coerceInput({ page: '' }, properties);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].path).toBe('page');
  });

  it('数值字面量（数值枚举）query 字符串转为数字', () => {
    // 模拟 enum Code { OK = 200, NotFound = 404 } → union of literal 200/404
    const properties: PropertyType[] = [
      {
        name: 'code',
        type: {
          kind: 'union',
          members: [
            { kind: 'literal', value: 200 },
            { kind: 'literal', value: 404 },
          ],
        },
        optional: false,
      },
    ];
    const result = coerceInput({ code: '200' }, properties);
    expect(result.issues).toEqual([]);
    expect(result.data.code).toBe(200);
  });

  it('字符串字面量（字符串枚举）不转换', () => {
    const properties: PropertyType[] = [
      {
        name: 'role',
        type: {
          kind: 'union',
          members: [
            { kind: 'literal', value: 'admin' },
            { kind: 'literal', value: 'user' },
          ],
        },
        optional: false,
      },
    ];
    const result = coerceInput({ role: 'admin' }, properties);
    expect(result.issues).toEqual([]);
    expect(result.data.role).toBe('admin');
  });

  it('元组 rest 元素按 rest 类型 coerce', () => {
    // 模拟 [string, ...number[]]
    const properties: PropertyType[] = [
      {
        name: 'list',
        type: {
          kind: 'tuple',
          elements: [
            { type: { kind: 'string' }, optional: false, rest: false },
            { type: { kind: 'number' }, optional: false, rest: true },
          ],
        },
        optional: false,
      },
    ];
    // query 传入 ['a', '1', '2', '3']，rest 元素都应转 number
    const result = coerceInput({ list: ['a', '1', '2', '3'] }, properties);
    expect(result.issues).toEqual([]);
    expect(result.data.list).toEqual(['a', 1, 2, 3]);
  });

  it('元组固定长度元素按位置 coerce', () => {
    // 模拟 [number, boolean]
    const properties: PropertyType[] = [
      {
        name: 'pair',
        type: {
          kind: 'tuple',
          elements: [
            { type: { kind: 'number' }, optional: false, rest: false },
            { type: { kind: 'boolean' }, optional: false, rest: false },
          ],
        },
        optional: false,
      },
    ];
    const result = coerceInput({ pair: ['1', 'true'] }, properties);
    expect(result.issues).toEqual([]);
    expect(result.data.pair).toEqual([1, true]);
  });
});
