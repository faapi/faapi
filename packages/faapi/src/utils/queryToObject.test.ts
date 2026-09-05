import { describe, it, expect } from 'vitest';
import { queryToObject } from './queryToObject';

describe('queryToObject', () => {
  it('基本查询参数转换', () => {
    const params = new URLSearchParams('page=1&pageSize=10');
    expect(queryToObject(params)).toEqual({ page: '1', pageSize: '10' });
  });

  it('单值保持字符串类型（非数组）', () => {
    const params = new URLSearchParams('a=1');
    expect(queryToObject(params)).toEqual({ a: '1' });
  });

  it('重复 key 聚合为数组（对齐 Express qs / Hono getAll）', () => {
    const params = new URLSearchParams('a=1&a=2&a=3');
    expect(queryToObject(params)).toEqual({ a: ['1', '2', '3'] });
  });

  it('两个重复 key', () => {
    const params = new URLSearchParams('ids=1&ids=2');
    expect(queryToObject(params)).toEqual({ ids: ['1', '2'] });
  });

  it('不同 key 互不影响', () => {
    const params = new URLSearchParams('tag=a&tag=b&page=1');
    expect(queryToObject(params)).toEqual({ tag: ['a', 'b'], page: '1' });
  });

  it('空参数返回空对象', () => {
    const params = new URLSearchParams();
    expect(queryToObject(params)).toEqual({});
  });
});
