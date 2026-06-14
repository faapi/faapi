import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadMiddlewaresFile } from './loadMiddlewares';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('loadMiddlewaresFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-mw-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('文件不存在时返回空 bundle', async () => {
    const bundle = await loadMiddlewaresFile(join(tempDir, 'middlewares.ts'));
    expect(bundle.middlewares).toEqual([]);
    expect(bundle.injectors).toEqual({});
  });

  it('加载有效的中间件数组（洋葱模型）', async () => {
    writeFileSync(
      join(tempDir, 'middlewares.ts'),
      `
export default [
  async (ctx, next) => { await next(); },
  async (ctx, next) => { try { await next(); } catch (e) { return new Response('err'); } },
];
`,
    );
    const bundle = await loadMiddlewaresFile(join(tempDir, 'middlewares.ts'));
    expect(bundle.middlewares).toHaveLength(2);
    expect(typeof bundle.middlewares[0]).toBe('function');
    expect(typeof bundle.middlewares[1]).toBe('function');
    expect(bundle.injectors).toEqual({});
  });

  it('加载 injectors 命名导出', async () => {
    writeFileSync(
      join(tempDir, 'middlewares.ts'),
      `
export const injectors = {
  db: () => ({ connected: true }),
  user: (ctx) => ctx.user,
};
`,
    );
    const bundle = await loadMiddlewaresFile(join(tempDir, 'middlewares.ts'));
    expect(bundle.middlewares).toEqual([]);
    expect(bundle.injectors.db).toBeInstanceOf(Function);
    expect(bundle.injectors.user).toBeInstanceOf(Function);
  });

  it('同时加载中间件和注入器', async () => {
    writeFileSync(
      join(tempDir, 'middlewares.ts'),
      `
export default [
  async (ctx, next) => { ctx.user = { name: 'alice' }; await next(); },
];
export const injectors = {
  user: (ctx) => ctx.user,
};
`,
    );
    const bundle = await loadMiddlewaresFile(join(tempDir, 'middlewares.ts'));
    expect(bundle.middlewares).toHaveLength(1);
    expect(typeof bundle.middlewares[0]).toBe('function');
    expect(bundle.injectors.user).toBeInstanceOf(Function);
  });

  it('忽略非函数的中间件项', async () => {
    writeFileSync(
      join(tempDir, 'middlewares.ts'),
      `
export default [
  async (ctx, next) => { await next(); },
  'invalid',       // 无效：不是函数
  { name: 'obj' }, // 无效：不是函数
  123,             // 无效：不是函数
];
`,
    );
    const bundle = await loadMiddlewaresFile(join(tempDir, 'middlewares.ts'));
    expect(bundle.middlewares).toHaveLength(1);
  });

  it('忽略非函数的注入器值', async () => {
    writeFileSync(
      join(tempDir, 'middlewares.ts'),
      `
export const injectors = {
  db: () => ({ connected: true }),
  invalid: 'not-a-function',
  bad: 123,
};
`,
    );
    const bundle = await loadMiddlewaresFile(join(tempDir, 'middlewares.ts'));
    expect(bundle.injectors.db).toBeInstanceOf(Function);
    expect(bundle.injectors.invalid).toBeUndefined();
    expect(bundle.injectors.bad).toBeUndefined();
  });

  it('default 不是数组时返回空', async () => {
    writeFileSync(
      join(tempDir, 'middlewares.ts'),
      `
export default { name: 'not-an-array' };
`,
    );
    const bundle = await loadMiddlewaresFile(join(tempDir, 'middlewares.ts'));
    expect(bundle.middlewares).toEqual([]);
    expect(bundle.injectors).toEqual({});
  });

  it('injectors 不是对象时返回空', async () => {
    writeFileSync(
      join(tempDir, 'middlewares.ts'),
      `
export const injectors = 'not-an-object';
`,
    );
    const bundle = await loadMiddlewaresFile(join(tempDir, 'middlewares.ts'));
    expect(bundle.middlewares).toEqual([]);
    expect(bundle.injectors).toEqual({});
  });
});
