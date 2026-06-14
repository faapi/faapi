import { describe, it, expect } from 'vitest';
import { normalizePath } from './normalizePath';

describe('normalizePath', () => {
  it('空字符串返回空字符串', () => {
    expect(normalizePath('')).toBe('');
  });

  it('单独斜杠返回空字符串', () => {
    expect(normalizePath('/')).toBe('');
  });

  it('去除尾部斜杠', () => {
    expect(normalizePath('/auth/login/')).toBe('/auth/login');
  });

  it('不以斜杠开头的路径自动补齐', () => {
    expect(normalizePath('auth/login')).toBe('/auth/login');
  });

  it('去除重复斜杠', () => {
    expect(normalizePath('//auth//login//')).toBe('/auth/login');
  });

  it('反斜杠替换为正斜杠', () => {
    expect(normalizePath('\\auth\\login')).toBe('/auth/login');
  });
});
