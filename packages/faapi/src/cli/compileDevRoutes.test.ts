import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileDevRoutes } from './compileDevRoutes';

/**
 * compileDevRoutes 测试：dev 模式逐文件编译
 *
 * 覆盖：
 * - 默认全量编译产物结构（打平 src 前缀）
 * - files 选项增量编译
 */
describe('compileDevRoutes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-compile-dev-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

    await compileDevRoutes({ rootDir: tempDir, dist: 'dist' });

    expect(existsSync(join(tempDir, 'dist/api/hello/handler.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'dist/api/user/handler.js'))).toBe(true);
    // src/ 前缀被剥离
    expect(existsSync(join(tempDir, 'dist/src/api/hello/handler.js'))).toBe(false);
  });

  it('files 选项支持增量编译', async () => {
    writeFile('src/api/a/handler.ts', `export function GET() { return 1; }\n`);
    writeFile('src/api/b/handler.ts', `export function GET() { return 2; }\n`);

    await compileDevRoutes({
      rootDir: tempDir,
      dist: 'dist',
      files: [join(tempDir, 'src/api/a/handler.ts')],
    });

    expect(existsSync(join(tempDir, 'dist/api/a/handler.js'))).toBe(true);
    // 只编译传入的文件，未传入的不编译
    expect(existsSync(join(tempDir, 'dist/api/b/handler.js'))).toBe(false);
  });

  it('无 .ts 文件时返回空结果', async () => {
    const result = await compileDevRoutes({ rootDir: tempDir, dist: 'dist' });
    expect(result.compiledFiles).toEqual([]);
  });

  it('原子写:编译后无 .tmp 残留文件', async () => {
    writeFile('src/api/hello/handler.ts', `export function GET() { return { ok: true }; }\n`);

    await compileDevRoutes({ rootDir: tempDir, dist: 'dist' });

    // 递归检查 dist 目录下无 .tmp 残留
    const tmpFiles = collectTmpFiles(join(tempDir, 'dist'));
    expect(tmpFiles).toEqual([]);
  });

  it('原子写:产物包含 sourcemap 且内容完整', async () => {
    writeFile('src/api/hello/handler.ts', `export function GET() { return { ok: true }; }\n`);

    await compileDevRoutes({ rootDir: tempDir, dist: 'dist' });

    const jsPath = join(tempDir, 'dist/api/hello/handler.js');
    const mapPath = join(tempDir, 'dist/api/hello/handler.js.map');
    expect(existsSync(jsPath)).toBe(true);
    expect(existsSync(mapPath)).toBe(true);

    // 产物内容完整:包含 export,不是半成品
    const jsContent = readFileSync(jsPath, 'utf-8');
    expect(jsContent).toContain('GET');
    expect(jsContent.length).toBeGreaterThan(0);
  });

  it('原子写:增量编译也用原子写(无 .tmp 残留)', async () => {
    writeFile('src/api/a/handler.ts', `export function GET() { return 1; }\n`);
    writeFile('src/api/b/handler.ts', `export function GET() { return 2; }\n`);

    await compileDevRoutes({
      rootDir: tempDir,
      dist: 'dist',
      files: [join(tempDir, 'src/api/a/handler.ts'), join(tempDir, 'src/api/b/handler.ts')],
    });

    const tmpFiles = collectTmpFiles(join(tempDir, 'dist'));
    expect(tmpFiles).toEqual([]);
    expect(existsSync(join(tempDir, 'dist/api/a/handler.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'dist/api/b/handler.js'))).toBe(true);
  });

  /** 递归收集目录下所有 .tmp 开头的文件名 */
  function collectTmpFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const result: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...collectTmpFiles(full));
      } else if (entry.name.includes('.tmp-')) {
        result.push(full);
      }
    }
    return result;
  }
});
