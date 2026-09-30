import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  copyResources,
  copyResourceFile,
  removeResourceFile,
  resolveResourcesDir,
} from './copyResources';

/**
 * copyResources 行为定义（见 copyResources.md）
 *
 * 镜像语义、跳过语义、单文件增量增删、路径归属校验。
 */
describe('copyResources', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-copy-resources-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('copyResources（镜像复制）', () => {
    it('无 src/resources 目录时跳过并返回 false，产物中不产生 resources 目录', async () => {
      const result = await copyResources(tempDir, '.faapi');
      expect(result).toBe(false);
      expect(existsSync(join(tempDir, '.faapi', 'resources'))).toBe(false);
    });

    it('镜像复制嵌套目录与中文文件名，内容逐字节一致', async () => {
      const resDir = join(tempDir, 'src', 'resources');
      mkdirSync(join(resDir, 'prompts', 'zh'), { recursive: true });
      writeFileSync(join(resDir, 'config.json'), '{"a":1}', 'utf-8');
      writeFileSync(join(resDir, 'prompts', '提示词.md'), '# 你好', 'utf-8');
      writeFileSync(join(resDir, 'prompts', 'zh', 'sys.txt'), '系统提示', 'utf-8');

      const result = await copyResources(tempDir, '.faapi');

      expect(result).toBe(true);
      const outDir = join(tempDir, '.faapi', 'resources');
      expect(readFileSync(join(outDir, 'config.json'), 'utf-8')).toBe('{"a":1}');
      expect(readFileSync(join(outDir, 'prompts', '提示词.md'), 'utf-8')).toBe('# 你好');
      expect(readFileSync(join(outDir, 'prompts', 'zh', 'sys.txt'), 'utf-8')).toBe('系统提示');
    });

    it('镜像语义：产物中已删除源文件的 stale 文件被清理', async () => {
      const resDir = join(tempDir, 'src', 'resources');
      mkdirSync(resDir, { recursive: true });
      writeFileSync(join(resDir, 'keep.txt'), 'keep', 'utf-8');

      // 预置一次复制，然后伪造产物 stale 文件 + 源侧删除文件
      await copyResources(tempDir, '.faapi');
      writeFileSync(join(tempDir, '.faapi', 'resources', 'stale.txt'), 'stale', 'utf-8');
      rmSync(join(resDir, 'keep.txt'));
      writeFileSync(join(resDir, 'fresh.txt'), 'fresh', 'utf-8');

      await copyResources(tempDir, '.faapi');

      expect(existsSync(join(tempDir, '.faapi', 'resources', 'stale.txt'))).toBe(false);
      expect(existsSync(join(tempDir, '.faapi', 'resources', 'keep.txt'))).toBe(false);
      expect(readFileSync(join(tempDir, '.faapi', 'resources', 'fresh.txt'), 'utf-8')).toBe(
        'fresh',
      );
    });
  });

  describe('copyResourceFile（watcher 单文件增量复制）', () => {
    it('复制单个文件到产物对应位置，自动创建父目录', async () => {
      const resDir = join(tempDir, 'src', 'resources');
      const source = join(resDir, 'prompts', 'foo.md');
      mkdirSync(join(resDir, 'prompts'), { recursive: true });
      writeFileSync(source, 'hello', 'utf-8');

      await copyResourceFile(tempDir, '.faapi', source);

      expect(readFileSync(join(tempDir, '.faapi', 'resources', 'prompts', 'foo.md'), 'utf-8')).toBe(
        'hello',
      );
    });

    it('源文件已在 change/unlink 竞态中被删除时跳过，不抛错', async () => {
      const source = join(tempDir, 'src', 'resources', 'gone.txt');
      mkdirSync(join(tempDir, 'src', 'resources'), { recursive: true });

      await expect(copyResourceFile(tempDir, '.faapi', source)).resolves.toBeUndefined();
      expect(existsSync(join(tempDir, '.faapi', 'resources', 'gone.txt'))).toBe(false);
    });

    it('源文件不在 src/resources 下时抛错，不静默复制任意路径', async () => {
      const outside = join(tempDir, 'src', 'api', 'handler.ts');
      mkdirSync(join(tempDir, 'src', 'api'), { recursive: true });
      writeFileSync(outside, 'export {}', 'utf-8');

      await expect(copyResourceFile(tempDir, '.faapi', outside)).rejects.toThrow();
    });
  });

  describe('removeResourceFile（watcher 单文件删除）', () => {
    it('删除产物中的对应文件', async () => {
      const resDir = join(tempDir, 'src', 'resources');
      mkdirSync(resDir, { recursive: true });
      writeFileSync(join(resDir, 'a.txt'), 'a', 'utf-8');
      await copyResources(tempDir, '.faapi');
      expect(existsSync(join(tempDir, '.faapi', 'resources', 'a.txt'))).toBe(true);

      await removeResourceFile(tempDir, '.faapi', join(resDir, 'a.txt'));

      expect(existsSync(join(tempDir, '.faapi', 'resources', 'a.txt'))).toBe(false);
    });

    it('产物文件不存在时幂等不抛错', async () => {
      const source = join(tempDir, 'src', 'resources', 'never.txt');
      mkdirSync(join(tempDir, 'src', 'resources'), { recursive: true });

      await expect(removeResourceFile(tempDir, '.faapi', source)).resolves.toBeUndefined();
    });

    it('源路径不在 src/resources 下时抛错', async () => {
      const outside = join(tempDir, 'src', 'api', 'handler.ts');
      await expect(removeResourceFile(tempDir, '.faapi', outside)).rejects.toThrow();
    });
  });

  describe('resolveResourcesDir（运行时定位）', () => {
    it('返回 <rootDir>/<dist>/resources 绝对路径', () => {
      expect(resolveResourcesDir('/proj', 'dist')).toBe(join('/proj', 'dist', 'resources'));
      expect(resolveResourcesDir('/proj', '.faapi')).toBe(join('/proj', '.faapi', 'resources'));
    });
  });
});
