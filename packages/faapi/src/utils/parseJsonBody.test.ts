import { describe, it, expect } from 'vitest';
import { parseJsonBody } from './parseJsonBody';

describe('parseJsonBody', () => {
  it('合法 JSON 返回 success: true', () => {
    const result = parseJsonBody('{"name":"faapi"}');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: 'faapi' });
    }
  });

  it('合法 JSON 数组返回 success: true', () => {
    const result = parseJsonBody('[1,2,3]');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([1, 2, 3]);
    }
  });

  it('非法 JSON 返回 success: false', () => {
    const result = parseJsonBody('not json');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Invalid JSON body');
    }
  });

  it('不完整的 JSON 返回 success: false', () => {
    const result = parseJsonBody('{"broken":');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Invalid JSON body');
    }
  });
});
