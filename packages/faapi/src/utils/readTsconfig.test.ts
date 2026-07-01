import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readTsconfig } from './readTsconfig';

describe('readTsconfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'faapi-tsc-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('正常情况：baseUrl + paths 解析为绝对路径', async () => {
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['src/*'] },
        },
      }),
    );

    const config = readTsconfig(dir);
    expect(config).not.toBeNull();
    expect(config!.baseUrl).toBe(dir);
    expect(config!.paths['@/*']).toEqual([path.join(dir, 'src', '*')]);
  });

  it('无 paths 返回 null', async () => {
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.' } }),
    );

    expect(readTsconfig(dir)).toBeNull();
  });

  it('无 tsconfig.json 返回 null', () => {
    expect(readTsconfig(dir)).toBeNull();
  });

  it('无 baseUrl 但有 paths：baseUrl 默认为 tsconfig 所在目录', async () => {
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { paths: { '@/*': ['src/*'] } },
      }),
    );

    const config = readTsconfig(dir);
    expect(config).not.toBeNull();
    expect(config!.baseUrl).toBe(dir);
    expect(config!.paths['@/*']).toEqual([path.join(dir, 'src', '*')]);
  });

  it('extends 继承父配置的 baseUrl 和 paths', async () => {
    // 父配置 base.json 与子配置同目录，baseUrl='.' 解析为该目录
    await writeFile(
      path.join(dir, 'base.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['src/*'], '@lib': ['src/lib'] },
        },
      }),
    );
    // 子配置：extends（不设 baseUrl，继承父的）
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ extends: './base.json' }),
    );

    const config = readTsconfig(dir);
    expect(config).not.toBeNull();
    expect(config!.baseUrl).toBe(dir);
    expect(config!.paths['@/*']).toEqual([path.join(dir, 'src', '*')]);
    expect(config!.paths['@lib']).toEqual([path.join(dir, 'src', 'lib')]);
  });

  it('子配置覆盖 extends 的 paths', async () => {
    await writeFile(
      path.join(dir, 'base.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
    );
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: './base.json',
        compilerOptions: { paths: { '@/*': ['app/*'] } },
      }),
    );

    const config = readTsconfig(dir);
    expect(config).not.toBeNull();
    expect(config!.paths['@/*']).toEqual([path.join(dir, 'app', '*')]);
  });

  it('paths 目标含 * 保留并解析为绝对路径', async () => {
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '~/*': ['src/utils/*'] },
        },
      }),
    );

    const config = readTsconfig(dir);
    expect(config!.paths['~/*']).toEqual([path.join(dir, 'src', 'utils', '*')]);
  });

  it('一个 pattern 映射多个目标，全部解析为绝对路径', async () => {
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['src/*', 'shared/*'] },
        },
      }),
    );

    const config = readTsconfig(dir);
    expect(config!.paths['@/*']).toEqual([
      path.join(dir, 'src', '*'),
      path.join(dir, 'shared', '*'),
    ]);
  });

  it('baseUrl 为子目录时解析为该子目录绝对路径', async () => {
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: 'app',
          paths: { '@/*': ['./*'] },
        },
      }),
    );

    const config = readTsconfig(dir);
    expect(config!.baseUrl).toBe(path.join(dir, 'app'));
    expect(config!.paths['@/*']).toEqual([path.join(dir, 'app', '*')]);
  });

  it('支持 JSON 注释（tsconfig 标准写法）', async () => {
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      `{
        // 路径别名
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "@/*": ["src/*"] } // 主别名
        }
      }`,
    );

    const config = readTsconfig(dir);
    expect(config).not.toBeNull();
    expect(config!.paths['@/*']).toEqual([path.join(dir, 'src', '*')]);
  });

  it('精确匹配别名（无 *）解析为绝对路径', async () => {
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@lib': ['src/lib'] },
        },
      }),
    );

    const config = readTsconfig(dir);
    expect(config!.paths['@lib']).toEqual([path.join(dir, 'src', 'lib')]);
  });
});
