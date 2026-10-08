import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadMiddlewaresFile,
  loadMergedMiddlewares,
  invalidateMiddlewareCache,
} from './loadMiddlewares';
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
    invalidateMiddlewareCache();
  });

  it('文件不存在时显式抛错（不降级为空 bundle）', async () => {
    await expect(loadMiddlewaresFile(join(tempDir, 'does-not-exist.ts'))).rejects.toThrow(
      /Cannot find|ERR_MODULE_NOT_FOUND|not exist/i,
    );
  });

  it('运行时抛错的中间件模块同样显式抛错（原始错误冒泡）', async () => {
    writeFileSync(join(tempDir, 'middlewares.ts'), `throw new Error('middleware init boom');`);
    await expect(loadMiddlewaresFile(join(tempDir, 'middlewares.ts'))).rejects.toThrow(
      'middleware init boom',
    );
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

  it('中间件项非函数时抛 TypeError（含文件路径），不再忽略', async () => {
    writeFileSync(
      join(tempDir, 'middlewares.ts'),
      `
export default [
  async (ctx, next) => { await next(); },
  'invalid',
];
`,
    );
    await expect(loadMiddlewaresFile(join(tempDir, 'middlewares.ts'))).rejects.toThrow(
      /every middleware must be a function.*middlewares\.ts/s,
    );
  });

  it('注入器值非函数时抛 TypeError（含注入器名与文件路径），不再忽略', async () => {
    writeFileSync(
      join(tempDir, 'middlewares.ts'),
      `
export const injectors = {
  db: () => ({ connected: true }),
  invalid: 'not-a-function',
};
`,
    );
    await expect(loadMiddlewaresFile(join(tempDir, 'middlewares.ts'))).rejects.toThrow(
      /injector "invalid" must be a function/,
    );
  });

  it('default 不是数组时抛 TypeError（不再返回空 bundle）', async () => {
    writeFileSync(
      join(tempDir, 'middlewares.ts'),
      `
export default { name: 'not-an-array' };
`,
    );
    await expect(loadMiddlewaresFile(join(tempDir, 'middlewares.ts'))).rejects.toThrow(
      /must export an array/,
    );
  });

  it('injectors 不是对象时抛 TypeError（不再返回空 bundle）', async () => {
    writeFileSync(
      join(tempDir, 'middlewares.ts'),
      `
export const injectors = 'not-an-object';
`,
    );
    await expect(loadMiddlewaresFile(join(tempDir, 'middlewares.ts'))).rejects.toThrow(
      /"injectors" export must be an object/,
    );
  });
});

describe('loadMergedMiddlewares 失败不缓存', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-mw-merge-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    invalidateMiddlewareCache();
  });

  it('加载失败每次调用显式抛错，不缓存空 bundle 静默返回', async () => {
    const mwPath = join(tempDir, 'middlewares.ts');
    writeFileSync(mwPath, `throw new Error('broken at first');`);
    // 旧语义：首次失败后缓存空 bundle，后续调用静默返回空（鉴权失效无感知）。
    // 新语义：每次调用都抛原始错误（dev 下经 watcher cache-bust 重新加载修复后的文件）
    await expect(loadMergedMiddlewares([mwPath])).rejects.toThrow('broken at first');
    await expect(loadMergedMiddlewares([mwPath])).rejects.toThrow('broken at first');
  });
});
