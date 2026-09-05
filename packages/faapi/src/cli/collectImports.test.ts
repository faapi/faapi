import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectRelativeImports } from './collectImports';

describe('collectRelativeImports', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-collect-imports-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(tempDir, 'src', 'api', 'users'), { recursive: true });
    mkdirSync(join(tempDir, 'src', 'lib'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('递归收集相对 import 的传递依赖（src 内）', async () => {
    const handler = join(tempDir, 'src', 'api', 'users', 'handler.ts');
    writeFileSync(
      handler,
      `import { findUser } from '../../lib/users';\nexport function GET() {}\n`,
    );
    writeFileSync(
      join(tempDir, 'src', 'lib', 'users.ts'),
      `import { db } from './db';\nexport function findUser() { return db; }\n`,
    );
    writeFileSync(join(tempDir, 'src', 'lib', 'db.ts'), `export const db = {};\n`);

    const { insideFiles, outsideFiles } = await collectRelativeImports([handler], tempDir);

    const names = insideFiles
      .map((f) => f.replace(/\\/g, '/'))
      .map((f) => f.slice(f.indexOf('src/')));
    expect(names).toContain('src/lib/users.ts');
    expect(names).toContain('src/lib/db.ts');
    expect(outsideFiles).toEqual([]);
  });

  it('入口文件本身不在结果中', async () => {
    const handler = join(tempDir, 'src', 'api', 'users', 'handler.ts');
    writeFileSync(handler, `export function GET() {}\n`);

    const { insideFiles } = await collectRelativeImports([handler], tempDir);
    expect(insideFiles).toEqual([]);
  });

  it('已带 .js 后缀的 specifier 不递归（视为产物依赖）', async () => {
    const handler = join(tempDir, 'src', 'api', 'users', 'handler.ts');
    writeFileSync(handler, `import x from './product.js';\nexport function GET() {}\n`);
    writeFileSync(join(tempDir, 'src', 'api', 'users', 'product.ts'), `export default 1;\n`);

    const { insideFiles } = await collectRelativeImports([handler], tempDir);
    expect(insideFiles).toEqual([]);
  });

  it('第三方包依赖不收集', async () => {
    const handler = join(tempDir, 'src', 'api', 'users', 'handler.ts');
    writeFileSync(handler, `import { z } from 'zod';\nexport function GET() {}\n`);

    const { insideFiles, outsideFiles } = await collectRelativeImports([handler], tempDir);
    expect(insideFiles).toEqual([]);
    expect(outsideFiles).toEqual([]);
  });

  it('src 外的项目文件归入 outsideFiles', async () => {
    mkdirSync(join(tempDir, 'shared'), { recursive: true });
    const handler = join(tempDir, 'src', 'api', 'users', 'handler.ts');
    writeFileSync(handler, `import { x } from '../../../shared/util';\nexport function GET() {}\n`);
    writeFileSync(join(tempDir, 'shared', 'util.ts'), `export const x = 1;\n`);

    const { insideFiles, outsideFiles } = await collectRelativeImports([handler], tempDir);
    expect(insideFiles).toEqual([]);
    expect(outsideFiles).toHaveLength(1);
    expect(outsideFiles[0]).toContain('shared');
  });

  it('支持 tsconfig paths 别名 specifier（@/lib/users）', async () => {
    writeFileSync(
      join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['./src/*'] },
        },
      }),
    );
    const handler = join(tempDir, 'src', 'api', 'users', 'handler.ts');
    writeFileSync(handler, `import { findUser } from '@/lib/users';\nexport function GET() {}\n`);
    writeFileSync(join(tempDir, 'src', 'lib', 'users.ts'), `export function findUser() {}\n`);

    const { insideFiles } = await collectRelativeImports([handler], tempDir);
    expect(insideFiles).toHaveLength(1);
    expect(insideFiles[0]).toContain(join('src', 'lib', 'users.ts'));
  });

  it('被多个入口引用的共享依赖只收集一次（去重）', async () => {
    const handlerA = join(tempDir, 'src', 'api', 'users', 'a.ts');
    const handlerB = join(tempDir, 'src', 'api', 'users', 'b.ts');
    writeFileSync(handlerA, `import { db } from '../../lib/db';\n`);
    writeFileSync(handlerB, `import { db } from '../../lib/db';\n`);
    writeFileSync(join(tempDir, 'src', 'lib', 'db.ts'), `export const db = {};\n`);

    const { insideFiles } = await collectRelativeImports([handlerA, handlerB], tempDir);
    expect(insideFiles).toHaveLength(1);
  });
});
