import { describe, it, expect } from 'vitest';
import { normalizePatterns } from './normalizePatterns';

describe('normalizePatterns', () => {
  it('单个 pattern 不变', () => {
    expect(normalizePatterns(['api/auth/*'])).toEqual(['api/auth/*']);
  });

  it('逗号分隔拆分', () => {
    expect(normalizePatterns(['api/auth/*,api/novel/*'])).toEqual(['api/auth/*', 'api/novel/*']);
  });

  it('去除空白', () => {
    expect(normalizePatterns([' api/auth/* , api/novel/* '])).toEqual([
      'api/auth/*',
      'api/novel/*',
    ]);
  });

  it('过滤空字符串', () => {
    expect(normalizePatterns(['api/auth/*,,api/novel/*'])).toEqual(['api/auth/*', 'api/novel/*']);
  });

  it('多个位置参数各自拆分', () => {
    expect(normalizePatterns(['api/auth/*,api/novel/*', 'api/user/*'])).toEqual([
      'api/auth/*',
      'api/novel/*',
      'api/user/*',
    ]);
  });

  it('空数组返回空数组', () => {
    expect(normalizePatterns([])).toEqual([]);
  });
});
