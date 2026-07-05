import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileBuildRoutes } from './compileBuildRoutes';

/**
 * compileBuildRoutes 测试：build 模式 bundle 编译
 *
 * 覆盖：
 * - define + minifySyntax 替换 process.env.NODE_ENV 并删除死分支
 * - splitting 提取共享依赖为 chunk
 * - 跨文件 dead code elimination（未引用的 export 被删除）
 */
describe('compileBuildRoutes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-compile-build-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** 写文件到 tempDir 下指定相对路径 */
  function writeFile(relPath: string, content: string) {
    const abs = join(tempDir, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  it('define + minifySyntax 替换 process.env.NODE_ENV 并删除死分支', async () => {
    writeFile(
      'src/api/hello/handler.ts',
      `export function GET() {
  if (process.env.NODE_ENV !== 'production') {
    console.log('debug');
  }
  return { ok: true };
}\n`,
    );

    await compileBuildRoutes({
      rootDir: tempDir,
      appDir: 'src',
      outDir: 'dist',
      entries: [join(tempDir, 'src/api/hello/handler.ts')],
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      minifySyntax: true,
    });

    const handler = readFileSync(join(tempDir, 'dist/api/hello/handler.js'), 'utf-8');
    // process.env.NODE_ENV 被替换为 'production'，分支条件变 false 被 minifySyntax 删除
    expect(handler).not.toContain('debug');
    expect(handler).not.toMatch(/process\.env\.NODE_ENV/);
  });

  it('splitting 提取共享依赖为 chunk', async () => {
    // 共享 utils.ts
    writeFile(
      'src/utils.ts',
      `export function shared() { return 'shared'; }
export function unused() { return 'unused'; }\n`,
    );
    // 两个 handler 都引用 utils.ts
    writeFile(
      'src/api/a/handler.ts',
      `import { shared } from '../../utils';
export function GET() { return shared(); }\n`,
    );
    writeFile(
      'src/api/b/handler.ts',
      `import { shared } from '../../utils';
export function GET() { return shared(); }\n`,
    );

    await compileBuildRoutes({
      rootDir: tempDir,
      appDir: 'src',
      outDir: 'dist',
      entries: [join(tempDir, 'src/api/a/handler.ts'), join(tempDir, 'src/api/b/handler.ts')],
      splitting: true,
      minifySyntax: true,
    });

    // 两个 handler.js 都存在
    expect(existsSync(join(tempDir, 'dist/api/a/handler.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'dist/api/b/handler.js'))).toBe(true);

    // handler.js 应该 import chunk（chunk-*.js）
    const handlerA = readFileSync(join(tempDir, 'dist/api/a/handler.js'), 'utf-8');
    expect(handlerA).toMatch(/chunk-[A-Z0-9]+\.js/);

    // unused 函数应被 tree shake 掉（不出现在任何产物中）
    const handlerB = readFileSync(join(tempDir, 'dist/api/b/handler.js'), 'utf-8');
    expect(handlerA).not.toContain('unused');
    expect(handlerB).not.toContain('unused');
  });

  it('跨文件 dead code elimination：未引用的 export 被删除', async () => {
    writeFile(
      'src/utils.ts',
      `export function used() { return 'used'; }
export function notUsed() { return 'not-used'; }\n`,
    );
    writeFile(
      'src/api/hello/handler.ts',
      `import { used } from '../../utils';
export function GET() { return used(); }\n`,
    );

    await compileBuildRoutes({
      rootDir: tempDir,
      appDir: 'src',
      outDir: 'dist',
      entries: [join(tempDir, 'src/api/hello/handler.ts')],
    });

    // handler.js 存在
    expect(existsSync(join(tempDir, 'dist/api/hello/handler.js'))).toBe(true);

    // utils.ts 不应作为独立文件存在（被 bundle 进 handler.js 或 chunk）
    expect(existsSync(join(tempDir, 'dist/utils.js'))).toBe(false);
  });

  it('空 entries 返回空结果', async () => {
    const result = await compileBuildRoutes({
      rootDir: tempDir,
      appDir: 'src',
      outDir: 'dist',
      entries: [],
    });
    expect(result.compiledFiles).toEqual([]);
  });
});
