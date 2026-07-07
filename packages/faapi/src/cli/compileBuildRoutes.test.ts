import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileBuildRoutes } from './compileBuildRoutes';

/**
 * compileBuildRoutes 测试：build 模式逐文件编译（与 dev 一致）
 *
 * 覆盖：
 * - 全量编译产物结构（打平 src 前缀）
 * - 相对 import 加 .js 后缀（aliasPlugin 行为）
 * - utils.ts 作为独立产物存在（不 bundle inline）
 * - process.env.NODE_ENV 编译期替换为 "production" + 死分支删除（define + minifySyntax）
 * - files 选项支持增量编译
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

  it('全量编译 .ts → .js，产物打平 src 前缀', async () => {
    writeFile('src/api/hello/handler.ts', `export function GET() { return { ok: true }; }\n`);
    writeFile('src/api/user/handler.ts', `export function GET() { return { ok: true }; }\n`);

    await compileBuildRoutes({ rootDir: tempDir, dist: 'dist' });

    expect(existsSync(join(tempDir, 'dist/api/hello/handler.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'dist/api/user/handler.js'))).toBe(true);
    // src/ 前缀被剥离
    expect(existsSync(join(tempDir, 'dist/src/api/hello/handler.js'))).toBe(false);
  });

  it('相对 import 加 .js 后缀（aliasPlugin 行为）', async () => {
    writeFile('src/utils.ts', `export const x = 1;\n`);
    writeFile(
      'src/api/hello/handler.ts',
      `import { x } from '../../utils';
export function GET() { return x; }\n`,
    );

    await compileBuildRoutes({ rootDir: tempDir, dist: 'dist' });

    const handler = readFileSync(join(tempDir, 'dist/api/hello/handler.js'), 'utf-8');
    // 相对 import 被重写为 .js 后缀（POSIX 风格）
    expect(handler).toMatch(/from\s+['"]\.\.\/\.\.\/utils\.js['"]/);
    expect(handler).not.toMatch(/from\s+['"]\.\.\/\.\.\/utils['"]/);
  });

  it('utils.ts 作为独立产物存在（不 bundle inline）', async () => {
    writeFile(
      'src/utils.ts',
      `export function usedHelper() { return 'used'; }
export function unusedHelper() { return 'unused'; }\n`,
    );
    writeFile(
      'src/api/hello/handler.ts',
      `import { usedHelper } from '../../utils';
export function GET() { return usedHelper(); }\n`,
    );

    await compileBuildRoutes({ rootDir: tempDir, dist: 'dist' });

    // utils.ts 作为独立产物存在（bundle:false 不 inline）
    expect(existsSync(join(tempDir, 'dist/utils.js'))).toBe(true);
    // 未引用的 export 也保留（不做 tree shaking）
    const utilsProduct = readFileSync(join(tempDir, 'dist/utils.js'), 'utf-8');
    expect(utilsProduct).toContain('usedHelper');
    expect(utilsProduct).toContain('unusedHelper');
  });

  it('process.env.NODE_ENV 编译期替换为 "production" + 死分支删除', async () => {
    writeFile(
      'src/api/hello/handler.ts',
      `export function GET() {
  if (process.env.NODE_ENV !== 'production') {
    console.log('debug');
  }
  return { ok: true };
}\n`,
    );

    await compileBuildRoutes({ rootDir: tempDir, dist: 'dist' });

    const handler = readFileSync(join(tempDir, 'dist/api/hello/handler.js'), 'utf-8');
    // process.env.NODE_ENV 被 define 替换为 "production"，产物中不含原始表达式
    expect(handler).not.toMatch(/process\.env\.NODE_ENV/);
    // if ("production" !== "production") 即 if (false)，minifySyntax 删除死分支
    expect(handler).not.toContain('debug');
  });

  it('不生成 chunk 文件（无 splitting）', async () => {
    // 共享 utils.ts
    writeFile('src/utils.ts', `export function shared() { return 'shared'; }\n`);
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

    await compileBuildRoutes({ rootDir: tempDir, dist: 'dist' });

    // 两个 handler.js 都存在
    expect(existsSync(join(tempDir, 'dist/api/a/handler.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'dist/api/b/handler.js'))).toBe(true);
    // utils.js 作为独立产物存在（不提取为 chunk）
    expect(existsSync(join(tempDir, 'dist/utils.js'))).toBe(true);
    // 无 chunk-*.js 文件
    const { readdirSync } = await import('node:fs');
    const distFiles = readdirSync(join(tempDir, 'dist'));
    expect(distFiles.some((f) => /^chunk-.*\.js$/.test(f))).toBe(false);
  });

  it('files 选项支持增量编译', async () => {
    writeFile('src/api/a/handler.ts', `export function GET() { return 1; }\n`);
    writeFile('src/api/b/handler.ts', `export function GET() { return 2; }\n`);

    await compileBuildRoutes({
      rootDir: tempDir,
      dist: 'dist',
      files: [join(tempDir, 'src/api/a/handler.ts')],
    });

    expect(existsSync(join(tempDir, 'dist/api/a/handler.js'))).toBe(true);
    // 只编译传入的文件，未传入的不编译
    expect(existsSync(join(tempDir, 'dist/api/b/handler.js'))).toBe(false);
  });

  it('无 .ts 文件时返回空结果', async () => {
    const result = await compileBuildRoutes({ rootDir: tempDir, dist: 'dist' });
    expect(result.compiledFiles).toEqual([]);
  });
});
