import { describe, it, expect } from 'vitest';
import { queryToObject } from './queryToObject';

describe('queryToObject', () => {
  it('基本查询参数转换', () => {
    const params = new URLSearchParams('page=1&pageSize=10');
    expect(queryToObject(params)).toEqual({ page: '1', pageSize: '10' });
  });

  it('重复 key 取最后一个值', () => {
    const params = new URLSearchParams('a=1&a=2&a=3');
    expect(queryToObject(params)).toEqual({ a: '3' });
  });

  it('空参数返回空对象', () => {
    const params = new URLSearchParams();
    expect(queryToObject(params)).toEqual({});
  });
});
