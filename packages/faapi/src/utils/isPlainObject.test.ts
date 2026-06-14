import { describe, it, expect } from 'vitest';
import { isPlainObject } from './isPlainObject';

describe('isPlainObject', () => {
  it('null 返回 false', () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it('数组返回 false', () => {
    expect(isPlainObject([1, 2, 3])).toBe(false);
  });

  it('Date 等内置对象返回 false', () => {
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(new Set())).toBe(false);
    expect(isPlainObject(new Error())).toBe(false);
  });

  it('普通对象 {} 返回 true', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it('Object.create(null) 返回 true', () => {
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it('原始类型返回 false', () => {
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject(123)).toBe(false);
    expect(isPlainObject('string')).toBe(false);
    expect(isPlainObject(true)).toBe(false);
  });
});
