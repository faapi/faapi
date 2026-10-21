import { describe, it, expect } from 'vitest';
import { validateRouteModule } from './validateRouteModule';

describe('validateRouteModule', () => {
  it('函数值通过校验不抛错', () => {
    const fn = () => 'ok';
    expect(() => validateRouteModule(fn, 'GET', '/api/handler.ts')).not.toThrow();
  });

  it('async 函数通过校验', () => {
    const fn = async () => 'ok';
    expect(() => validateRouteModule(fn, 'POST', '/api/handler.ts')).not.toThrow();
  });

  it('字符串抛错并含 filePath 和 method', () => {
    expect(() => validateRouteModule('not-a-fn', 'GET', '/api/user/handler.ts')).toThrow(
      /\/api\/user\/handler\.ts/,
    );
    expect(() => validateRouteModule('not-a-fn', 'GET', '/api/user/handler.ts')).toThrow(/GET/);
  });

  it('undefined 抛错', () => {
    expect(() => validateRouteModule(undefined, 'POST', '/api/h.ts')).toThrow(
      /does not export a valid handler/,
    );
  });

  it('null 抛错', () => {
    expect(() => validateRouteModule(null, 'GET', '/api/h.ts')).toThrow();
  });

  it('对象抛错并提示实际类型', () => {
    expect(() => validateRouteModule({ foo: 1 }, 'PUT', '/api/h.ts')).toThrow(/object/);
  });

  it('数字抛错', () => {
    expect(() => validateRouteModule(42, 'GET', '/api/h.ts')).toThrow(/number/);
  });

  it('错误消息包含Expected a function提示', () => {
    expect(() => validateRouteModule(false, 'GET', '/api/h.ts')).toThrow(/Expected a function/);
  });
});
