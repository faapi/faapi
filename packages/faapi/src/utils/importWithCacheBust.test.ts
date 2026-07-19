import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setLoadTimestamp, importWithCacheBust } from './importWithCacheBust';

describe('importWithCacheBust', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('设置时间戳后能 import ESM 模块', async () => {
    const file = join(tempDir, 'mod.js');
    writeFileSync(file, 'export const value = 42;\n');
    setLoadTimestamp(Date.now());
    const mod = await importWithCacheBust(file);
    expect(mod.value).toBe(42);
  });

  it('能加载具名导出和默认导出', async () => {
    const file = join(tempDir, 'mod.js');
    writeFileSync(file, 'export const named = "n";\nexport default "d";\n');
    setLoadTimestamp(Date.now());
    const mod = await importWithCacheBust(file);
    expect(mod.named).toBe('n');
    expect(mod.default).toBe('d');
  });

  it('不存在的文件路径抛错', async () => {
    setLoadTimestamp(Date.now());
    await expect(importWithCacheBust(join(tempDir, 'no-such.js'))).rejects.toThrow();
  });
});

describe('importWithCacheBust 在 vitest 环境走 Vite pipeline', () => {
  let tempDir: string;
  const originalVi = (globalThis as { vi?: unknown }).vi;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    // 恢复原始 vi（vitest 注入的全局）
    if (originalVi === undefined) {
      delete (globalThis as { vi?: unknown }).vi;
    } else {
      (globalThis as { vi?: unknown }).vi = originalVi;
    }
  });

  it('globalThis.vi.importActual 存在时优先走 Vite pipeline', async () => {
    const file = join(tempDir, 'mod.js');
    writeFileSync(file, 'export const value = "vite-loaded";\n');

    // 用 spy 替换 vi.importActual，验证被调用
    const importActualSpy = vi.fn(async (p: string) => {
      // 走真实 Vite pipeline（vitest 注入的 vi.importActual 能加载绝对路径）
      return await originalViImportActual(p);
    });
    (globalThis as { vi?: { importActual: typeof importActualSpy } }).vi = {
      importActual: importActualSpy,
    };

    const mod = await importWithCacheBust(file);
    expect(importActualSpy).toHaveBeenCalledOnce();
    expect(importActualSpy).toHaveBeenCalledWith(file);
    expect(mod.value).toBe('vite-loaded');
  });

  it('globalThis.vi 存在但 importActual 缺失时回退到 Node 原生 import', async () => {
    const file = join(tempDir, 'mod.js');
    writeFileSync(file, 'export const value = "node-loaded";\n');

    // vi 存在但 importActual 不是函数
    (globalThis as { vi?: { importActual?: unknown } }).vi = {};

    setLoadTimestamp(Date.now());
    const mod = await importWithCacheBust(file);
    expect(mod.value).toBe('node-loaded');
  });

  it('globalThis.vi 不存在时走 Node 原生 import', async () => {
    const file = join(tempDir, 'mod.js');
    writeFileSync(file, 'export const value = "node-loaded";\n');

    delete (globalThis as { vi?: unknown }).vi;

    setLoadTimestamp(Date.now());
    const mod = await importWithCacheBust(file);
    expect(mod.value).toBe('node-loaded');
  });

  it('vi.importActual 抛错时异常向上传播', async () => {
    const file = join(tempDir, 'mod.js');
    writeFileSync(file, 'export const value = 1;\n');

    (globalThis as { vi?: { importActual: () => Promise<never> } }).vi = {
      importActual: async () => {
        throw new Error('vite pipeline error');
      },
    };

    await expect(importWithCacheBust(file)).rejects.toThrow('vite pipeline error');
  });
});

/**
 * 持有原始 vitest vi.importActual 引用，供 spy 内部调用真实 Vite pipeline
 */
function originalViImportActual(p: string): Promise<unknown> {
  // vitest globals: true 下，原始 vi 已在测试初始化时被捕获
  // 通过 dynamic import vitest 拿到 vi
  return import('vitest').then((m) => m.vi.importActual(p));
}
