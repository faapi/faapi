import { describe, it, expect } from 'vitest';
import { collectConfigSnapshot } from './configSnapshot';

/**
 * 隔离任务配置快照测试：函数值不进快照（与 registries 快照同款边界）、
 * 其余值 structuredClone 保真、非函数不可克隆值派发显式报错列路径
 */

describe('collectConfigSnapshot', () => {
  it('纯数据直通：整体 structuredClone 成功，深层数据原样', () => {
    const config = {
      port: 3000,
      task: { driver: 'pgboss', shutdownTimeoutMs: 8000 },
      nested: { deep: { arr: [1, 'two', { ok: true }] } },
    };
    expect(collectConfigSnapshot(config)).toEqual(config);
  });

  it('Date/Map/Set 子树保真（structuredClone 语义，非 JSON 变形）', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const config = { at, tags: new Set(['a']), meta: new Map([['k', 1]]) };
    const snapshot = collectConfigSnapshot(config) as typeof config;
    expect(snapshot.at).toBeInstanceOf(Date);
    expect(snapshot.at.getTime()).toBe(at.getTime());
    expect(snapshot.tags).toBeInstanceOf(Set);
    expect(snapshot.meta).toBeInstanceOf(Map);
  });

  it('函数值不进快照（顶层/嵌套），其余字段保留', () => {
    const config = {
      port: 3000,
      lifecycle: {
        onBoot: () => {},
        onReady: async () => {},
      },
      task: {
        driver: 'pgboss',
        onFailed: () => {},
      },
    };
    const snapshot = collectConfigSnapshot(config) as {
      port: number;
      lifecycle: Record<string, unknown>;
      task: Record<string, unknown>;
    };
    expect(snapshot.port).toBe(3000);
    expect(snapshot.lifecycle).toEqual({});
    expect(snapshot.task).toEqual({ driver: 'pgboss' });
  });

  it('symbol 值不进快照', () => {
    const config = { port: 1, weird: Symbol('x') };
    expect(collectConfigSnapshot(config)).toEqual({ port: 1 });
  });

  it('数组内函数剔除保位序（占位 undefined），数组整体结构不变', () => {
    const config = {
      steps: [() => {}, { n: 1 }, 'keep'],
    };
    const snapshot = collectConfigSnapshot(config) as { steps: unknown[] };
    expect(snapshot.steps).toHaveLength(3);
    expect(snapshot.steps[0]).toBeUndefined();
    expect(snapshot.steps[1]).toEqual({ n: 1 });
    expect(snapshot.steps[2]).toBe('keep');
  });

  it('快照整体可结构化克隆（postMessage 可过），且不回传函数', () => {
    const config = { a: { b: { c: () => {} } }, d: [new Date(0)] };
    const snapshot = collectConfigSnapshot(config);
    expect(() => structuredClone(snapshot)).not.toThrow();
    expect(JSON.stringify(snapshot)).not.toContain('c');
  });

  it('非函数不可克隆值：显式抛错并列出路径（不剔除不降级）', () => {
    const config = {
      port: 1,
      holder: { p: Promise.resolve(1) },
    };
    expect(() => collectConfigSnapshot(config)).toThrow(/holder\.p/);
  });

  it('WeakMap 不可克隆：抛错路径正确', () => {
    const config = { m: new WeakMap() };
    expect(() => collectConfigSnapshot(config)).toThrow(/config\.m/);
  });

  it('类实例：structuredClone 可克隆，保留为数据（退化为纯对象语义）', () => {
    class Box {
      constructor(public v: number) {}
    }
    const snapshot = collectConfigSnapshot({ box: new Box(3) }) as { box: { v: number } };
    expect(snapshot.box.v).toBe(3);
    expect(() => structuredClone(snapshot)).not.toThrow();
  });

  it('空对象/undefined 字段原样保留', () => {
    const config = { a: {}, b: undefined, c: null };
    const snapshot = collectConfigSnapshot(config) as typeof config;
    expect(snapshot.a).toEqual({});
    expect('b' in snapshot).toBe(true);
    expect(snapshot.b).toBeUndefined();
    expect(snapshot.c).toBeNull();
  });
});
