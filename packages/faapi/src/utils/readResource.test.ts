import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readResource, setActiveResourcesDir } from './readResource';
import { createTestContext } from '../runtime/createContext';

describe('readResource', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'faapi-read-resource-'));
    // resources 目录外的兄弟文件：证明"存在的文件"也会被越界校验拦下
    await writeFile(path.join(path.dirname(root), 'outside.txt'), 'secret');
    await mkdir(path.join(root, 'prompts'), { recursive: true });
    await writeFile(path.join(root, 'prompts/greeting.md'), 'hello resource');
    await writeFile(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  afterAll(async () => {
    setActiveResourcesDir(null);
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    // 免传参 readResource 依赖进程级绑定（createAppBase 启动时绑定）；测试直绑
    setActiveResourcesDir(root);
  });

  it('读取文本资源（传 encoding 返回 string）', async () => {
    await expect(readResource('prompts/greeting.md', 'utf-8')).resolves.toBe('hello resource');
  });

  it('读取二进制资源（省略 encoding 返回 Buffer）', async () => {
    const buf = await readResource('logo.png');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect((buf as Buffer).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  });

  it('前导 ./ 的相对路径正常读取', async () => {
    await expect(readResource('./prompts/greeting.md', 'utf-8')).resolves.toBe('hello resource');
  });

  it('中间 .. 规范化后仍在 resources 内的路径正常读取', async () => {
    await expect(readResource('prompts/../prompts/greeting.md', 'utf-8')).resolves.toBe(
      'hello resource',
    );
  });

  it('未绑定（无存活 app）→ 抛清晰错误', async () => {
    setActiveResourcesDir(null);
    await expect(readResource('prompts/greeting.md', 'utf-8')).rejects.toThrow(/no active app/);
  });

  it('.. 穿越到 resources 外 → 抛错（目标文件存在也拦下）', async () => {
    await expect(readResource('../outside.txt', 'utf-8')).rejects.toThrow(/escapes/);
  });

  it('深层穿越（a/../../outside.txt）→ 抛错', async () => {
    await expect(readResource('prompts/../../outside.txt', 'utf-8')).rejects.toThrow(/escapes/);
  });

  it('绝对路径 → 抛错', async () => {
    const abs = path.join(path.dirname(root), 'outside.txt');
    await expect(readResource(abs, 'utf-8')).rejects.toThrow(/escapes/);
  });

  it('相对路径解析为 resources 目录本身（.）→ 抛错', async () => {
    await expect(readResource('.', 'utf-8')).rejects.toThrow(/escapes/);
  });

  it('符号链接指向 resources 外 → 抛错（真实路径越界）', async () => {
    const link = path.join(root, 'evil-link.md');
    await symlink(path.join(path.dirname(root), 'outside.txt'), link);
    await expect(readResource('evil-link.md', 'utf-8')).rejects.toThrow(/symlink/);
  });

  it('符号链接指向 resources 内 → 正常读取（合法软链不误伤）', async () => {
    const link = path.join(root, 'alias-link.md');
    await symlink(path.join(root, 'prompts/greeting.md'), link);
    await expect(readResource('alias-link.md', 'utf-8')).resolves.toBe('hello resource');
  });

  it('文件不存在 → 传播自然 ENOENT', async () => {
    await expect(readResource('prompts/missing.md', 'utf-8')).rejects.toThrow(/ENOENT/);
  });

  it('resources 目录本身不存在 → 抛 ENOENT', async () => {
    setActiveResourcesDir(path.join(root, 'no-such-resources'));
    await expect(readResource('x.md', 'utf-8')).rejects.toThrow(/ENOENT/);
  });

  it('relativePath 为空字符串 → 抛错', async () => {
    await expect(readResource('', 'utf-8')).rejects.toThrow(/non-empty string/);
  });

  it('relativePath 非字符串（JS 调用方）→ 抛错', async () => {
    await expect(readResource(123 as unknown as string, 'utf-8')).rejects.toThrow(
      /non-empty string/,
    );
  });

  it('绑定经 globalThis 承载（taskWorker 内联播种依赖同一 symbol key）', () => {
    setActiveResourcesDir(root);
    expect(
      (globalThis as Record<symbol, string | undefined>)[Symbol.for('faapi.resources.dir')],
    ).toBe(root);
    setActiveResourcesDir(null);
    expect(
      (globalThis as Record<symbol, string | undefined>)[Symbol.for('faapi.resources.dir')],
    ).toBeUndefined();
  });
});

describe('createTestContext 的 resourcesDir 选项（绑定全局 readResource）', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'faapi-read-resource-ctx-'));
    await writeFile(path.join(root, 'greeting.md'), 'hello from ctx');
  });

  afterAll(async () => {
    setActiveResourcesDir(null);
    await rm(root, { recursive: true, force: true });
  });

  it('传入 resourcesDir 后，免传参 readResource 可读资源', async () => {
    createTestContext({ path: '/api/x', resourcesDir: root });
    await expect(readResource('greeting.md', 'utf-8')).resolves.toBe('hello from ctx');
  });

  it('越界路径同样被拦下', async () => {
    createTestContext({ path: '/api/x', resourcesDir: root });
    await expect(readResource('../outside.txt', 'utf-8')).rejects.toThrow(/escapes/);
  });
});
