import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
