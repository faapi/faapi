import { describe, it, expect } from 'vitest';
import { resolveExport } from './resolveExports';

describe('resolveExport', () => {
  it('具名导出存在时返回具名导出', () => {
    const mod = { GET: () => 'hello', default: { GET: () => 'fallback' } };
    expect(resolveExport(mod, 'GET')).toBe(mod.GET);
  });

  it('具名导出为 undefined 时落入 default 查找', () => {
    const mod = { GET: undefined, default: { GET: () => 'from-default' } };
    expect(resolveExport(mod, 'GET')).toBe(mod.default.GET);
  });

  it('无具名导出但 default 对象有同名属性时返回 default 属性', () => {
    const mod = { default: { POST: () => 'from-default' } };
    expect(resolveExport(mod, 'POST')).toBe(mod.default.POST);
  });

  it('default 为 null 时返回 undefined', () => {
    const mod = { default: null };
    expect(resolveExport(mod, 'GET')).toBeUndefined();
  });

  it('default 为非对象时返回 undefined', () => {
    const mod = { default: 'not-an-object' };
    expect(resolveExport(mod, 'GET')).toBeUndefined();
  });

  it('default 对象无同名属性时返回 undefined', () => {
    const mod = { default: { other: 1 } };
    expect(resolveExport(mod, 'GET')).toBeUndefined();
  });

  it('既无具名也无 default 时返回 undefined', () => {
    expect(resolveExport({}, 'GET')).toBeUndefined();
  });

  it('default 对象属性为 undefined 时返回 undefined', () => {
    const mod = { default: { GET: undefined } };
    expect(resolveExport(mod, 'GET')).toBeUndefined();
  });
});
