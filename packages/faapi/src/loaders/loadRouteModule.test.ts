import { describe, it, expect } from 'vitest';
import { loadRouteModule } from './loadRouteModule';
import { resolveExport } from './resolveExports';
import { validateRouteModule } from './validateRouteModule';
import path from 'node:path';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures');

describe('resolveExport', () => {
  it('从模块对象中提取指定导出', () => {
    const mod = { GET: () => 'ok', POST: () => 'created' };
    expect(resolveExport(mod, 'GET')).toBe(mod.GET);
    expect(resolveExport(mod, 'POST')).toBe(mod.POST);
  });

  it('导出不存在时返回 undefined', () => {
    const mod = { POST: () => 'created' };
    expect(resolveExport(mod, 'GET')).toBeUndefined();
  });
});

describe('validateRouteModule', () => {
  it('函数值通过校验', () => {
    const fn = () => {};
    expect(() => validateRouteModule(fn, 'GET', '/test.ts')).not.toThrow();
  });

  it('非函数值抛出错误，包含文件路径和方法名', () => {
    expect(() => validateRouteModule('not a function', 'GET', '/api/test.ts')).toThrow(
      /\/api\/test\.ts.*GET/,
    );
  });

  it('undefined 值抛出错误', () => {
    expect(() => validateRouteModule(undefined, 'POST', '/api/login.ts')).toThrow(
      /\/api\/login\.ts.*POST/,
    );
  });
});

describe('loadRouteModule', () => {
  it('成功加载合法模块', async () => {
    const filePath = path.join(FIXTURES_DIR, 'modules', 'valid.ts');
    const result = await loadRouteModule(filePath, 'GET');
    expect(result.method).toBe('GET');
    expect(typeof result.handler).toBe('function');
    expect(result.handler()).toEqual({ ok: true });
  });

  it('加载不存在的文件时抛错', async () => {
    const filePath = path.join(FIXTURES_DIR, 'modules', 'nonexistent.ts');
    await expect(loadRouteModule(filePath, 'GET')).rejects.toThrow(
      /Failed to load route module.*nonexistent\.ts/,
    );
  });

  it('导出不是函数时抛错', async () => {
    const filePath = path.join(FIXTURES_DIR, 'modules', 'invalid-not-function.ts');
    await expect(loadRouteModule(filePath, 'GET')).rejects.toThrow(/invalid-not-function\.ts.*GET/);
  });

  it('缺少指定导出时抛错', async () => {
    const filePath = path.join(FIXTURES_DIR, 'modules', 'invalid-no-export.ts');
    await expect(loadRouteModule(filePath, 'GET')).rejects.toThrow(/invalid-no-export\.ts.*GET/);
  });
});
