import { describe, it, expect } from 'vitest';
import { mergeVary } from './mergeVary';
import type { ResponseMeta } from '../runtime/contextTypes';

const makeMeta = (): ResponseMeta => ({ headers: {}, setCookies: [] });

describe('mergeVary', () => {
  it('空 meta 写入 Vary', () => {
    const meta = makeMeta();
    mergeVary(meta, 'Origin');
    expect(meta.headers['Vary']).toBe('Origin');
  });

  it('已有值时逗号合并，不覆盖', () => {
    const meta = makeMeta();
    mergeVary(meta, 'Origin');
    mergeVary(meta, 'Accept-Encoding');
    expect(meta.headers['Vary']).toBe('Origin, Accept-Encoding');
  });

  it('大小写不敏感去重（含大小写变体头键）', () => {
    const meta = makeMeta();
    meta.headers['vary'] = 'accept-encoding';
    mergeVary(meta, 'Accept-Encoding');
    expect(meta.headers['vary']).toBe('accept-encoding');
    expect(meta.headers['Vary']).toBeUndefined();
  });

  it('按逗号分段精确匹配：X-Origin 不误判为已含 Origin', () => {
    const meta = makeMeta();
    meta.headers['Vary'] = 'X-Origin';
    mergeVary(meta, 'Origin');
    expect(meta.headers['Vary']).toBe('X-Origin, Origin');
  });

  it('合并时保留原头键大小写', () => {
    const meta = makeMeta();
    meta.headers['vary'] = 'Origin';
    mergeVary(meta, 'Accept-Encoding');
    expect(meta.headers['vary']).toBe('Origin, Accept-Encoding');
  });
});
