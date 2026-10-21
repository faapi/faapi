import { describe, it, expect } from 'vitest';
import { DIR_SEGMENT_PATTERN, LLM_TOOL_NAME_PATTERN } from './nameRules';

describe('DIR_SEGMENT_PATTERN（目录段白名单）', () => {
  it('拒绝段内下划线（_ 被 / 规范化独占为嵌套分隔符，段内禁用）', () => {
    expect(DIR_SEGMENT_PATTERN.test('a_b')).toBe(false);
  });

  it('拒绝点号', () => {
    expect(DIR_SEGMENT_PATTERN.test('a.b')).toBe(false);
  });

  it('拒绝中文', () => {
    expect(DIR_SEGMENT_PATTERN.test('写作')).toBe(false);
  });

  it('拒绝空格', () => {
    expect(DIR_SEGMENT_PATTERN.test('a b')).toBe(false);
  });

  it('接受连字符', () => {
    expect(DIR_SEGMENT_PATTERN.test('a-b')).toBe(true);
  });

  it('接受纯字母数字', () => {
    expect(DIR_SEGMENT_PATTERN.test('abc')).toBe(true);
  });
});

describe('LLM_TOOL_NAME_PATTERN（LLM 工具名字符集）', () => {
  it('接受下划线（_ 不被目录段白名单允许，但合成名连接位可用）', () => {
    expect(LLM_TOOL_NAME_PATTERN.test('a_b')).toBe(true);
  });

  it('拒绝点号', () => {
    expect(LLM_TOOL_NAME_PATTERN.test('a.b')).toBe(false);
  });

  it('嵌套名（各段满足目录段白名单 + _ 连接）恒满足该 pattern', () => {
    const segments = ['easy-writing', 'wizard', 'v2'];
    const nested = segments.join('_');
    expect(segments.every((s) => DIR_SEGMENT_PATTERN.test(s))).toBe(true);
    expect(LLM_TOOL_NAME_PATTERN.test(nested)).toBe(true);
  });
});
