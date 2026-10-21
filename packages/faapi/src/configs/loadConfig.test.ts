import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './loadConfig';

/**
 * 创建临时目录并在其中写入配置文件
 *
 * 支持嵌套路径（如 'dist/faapi-config.js'）。
 */
function createTempDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-config-test-'));
  for (const [fileName, content] of Object.entries(files)) {
    const filePath = path.join(dir, fileName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
  return dir;
}

/** 清理临时目录 */
function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('loadConfig', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      cleanupDir(dir);
    }
    tempDirs.length = 0;
  });

  const makeDir = (files?: Record<string, string>) => {
    const dir = createTempDir(files);
    tempDirs.push(dir);
    return dir;
  };

  it('无配置文件时返回 null', async () => {
    const dir = makeDir();
    const result = await loadConfig(dir, 'dist');
    expect(result).toBeNull();
  });

  it('<dist>/faapi-config.js 存在时直接 import 产物', async () => {
    const dir = makeDir({
      'dist/faapi-config.js': `export default { port: 9999, db: { host: 'prod' } };\n`,
    });

    const result = await loadConfig(dir, 'dist');
    expect(result).not.toBeNull();
    expect(result!.port).toBe(9999);
    expect(result!.db).toEqual({ host: 'prod' });
  });

  it('可指定任意 dist（如 .faapi）', async () => {
    const dir = makeDir({
      '.faapi/faapi-config.js': `export default { port: 3000 };\n`,
    });

    const result = await loadConfig(dir, '.faapi');
    expect(result).not.toBeNull();
    expect(result!.port).toBe(3000);
  });

  it('产物不存在但源码有 faapi.config.ts 时抛错', async () => {
    const dir = makeDir({
      'faapi.config.ts': `export default { port: 3000 };\n`,
    });

    await expect(loadConfig(dir, 'dist')).rejects.toThrow(/dist\/faapi-config\.js 不存在/);
  });

  it('产物不存在但源码有 faapi.config.js 时抛错', async () => {
    const dir = makeDir({
      'faapi.config.js': `export default { port: 3000 };\n`,
    });

    await expect(loadConfig(dir, 'dist')).rejects.toThrow(/dist\/faapi-config\.js 不存在/);
  });

  it('错误消息包含 build/dev 提示', async () => {
    const dir = makeDir({
      'faapi.config.ts': `export default { port: 3000 };\n`,
    });

    await expect(loadConfig(dir, 'dist')).rejects.toThrow(/faapi build/);
  });

  it('产物 default 为 undefined 时返回空对象', async () => {
    const dir = makeDir({
      'dist/faapi-config.js': `export const something = 'else';\n`,
    });

    const result = await loadConfig(dir, 'dist');
    expect(result).toEqual({});
  });

  it('产物文件语法错误时抛错', async () => {
    const dir = makeDir({
      'faapi.config.ts': `export default { port: 3000 };\n`, // 源码存在使校验路径不抛错
      'dist/faapi-config.js': `export default {\n  port: 8080,\n  // 缺少闭合括号\n`,
    });

    await expect(loadConfig(dir, 'dist')).rejects.toThrow();
  });
});
