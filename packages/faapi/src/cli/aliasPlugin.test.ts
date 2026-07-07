import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toProdExtension, createAliasPlugin, buildAliasPlugins } from './aliasPlugin';
import type { TsconfigPathsConfig } from '../utils/readTsconfig';

describe('toProdExtension', () => {
  it('.ts 后缀转 .js', () => {
    expect(toProdExtension('user/handler.ts')).toBe('user/handler.js');
  });

  it('.tsx 后缀转 .js', () => {
    expect(toProdExtension('user/handler.tsx')).toBe('user/handler.js');
  });

  it('.jsx 后缀转 .js', () => {
    expect(toProdExtension('user/handler.jsx')).toBe('user/handler.js');
  });

  it('.js 后缀保持不变', () => {
    expect(toProdExtension('user/handler.js')).toBe('user/handler.js');
  });

  it('.mjs 后缀保持不变', () => {
    expect(toProdExtension('user/handler.mjs')).toBe('user/handler.mjs');
  });

  it('无后缀文件保持不变', () => {
    expect(toProdExtension('README')).toBe('README');
  });
});

describe('buildAliasPlugins', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-alias-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('无 tsconfig 时仍返回插件（相对路径重写不依赖 tsconfig）', () => {
    const plugins = buildAliasPlugins(tempDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('faapi-alias');
  });

  it('有 tsconfig.paths 时返回含别名的插件', () => {
    writeFileSync(
      join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          paths: { '@/*': ['./src/*'] },
        },
      }),
      'utf-8',
    );
    const plugins = buildAliasPlugins(tempDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('faapi-alias');
  });

  it('tsconfig 无 paths 时仍返回插件（相对路径重写不依赖 paths）', () => {
    writeFileSync(join(tempDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }), 'utf-8');
    const plugins = buildAliasPlugins(tempDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('faapi-alias');
  });
});

describe('createAliasPlugin onLoad', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-alias-onload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** 构造一个最小化的 esbuild-like onLoad 上下文，验证别名重写 */
  function applyOnLoad(plugin: ReturnType<typeof createAliasPlugin>, filePath: string) {
    let captured: { contents: string; loader: string } | undefined;
    const build = {
      onLoad(_filter: unknown, cb: (args: { path: string }) => unknown) {
        captured = cb({ path: filePath }) as { contents: string; loader: string } | undefined;
      },
    };
    plugin.setup(build as never);
    return captured;
  }

  it('别名 specifier 被重写为相对产物路径', () => {
    mkdirSync(join(tempDir, 'src', 'utils'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'utils', 'helper.ts'), 'export const x = 1;\n');
    const importer = join(tempDir, 'src', 'handler.ts');
    writeFileSync(importer, `import { x } from '@/utils/helper';\n`, 'utf-8');

    const config: TsconfigPathsConfig = {
      baseUrl: tempDir,
      paths: { '@/*': [join(tempDir, 'src/*')] },
    };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result).toBeDefined();
    expect(result!.contents).toContain('./utils/helper.js');
    expect(result!.contents).not.toContain('@/utils/helper');
  });

  it('相对路径 specifier（无后缀）被重写为 .js 后缀', () => {
    // 创建被 import 的源文件
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'helper.ts'), 'export const x = 1;\n', 'utf-8');
    const importer = join(tempDir, 'src', 'handler.ts');
    writeFileSync(importer, `import { x } from './helper';\n`, 'utf-8');

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result).toBeDefined();
    expect(result!.contents).toContain('./helper.js');
    expect(result!.contents).not.toMatch(/from\s+['"]\.\/helper['"]/);
  });

  it('相对路径 specifier（.ts 后缀）被重写为 .js 后缀', () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'helper.ts'), 'export const x = 1;\n', 'utf-8');
    const importer = join(tempDir, 'src', 'handler.ts');
    writeFileSync(importer, `import { x } from './helper.ts';\n`, 'utf-8');

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result).toBeDefined();
    expect(result!.contents).toContain('./helper.js');
    expect(result!.contents).not.toContain('./helper.ts');
  });

  it('相对路径 specifier（.js 后缀）保持不变', () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'helper.js'), 'export const x = 1;\n', 'utf-8');
    const importer = join(tempDir, 'src', 'handler.ts');
    writeFileSync(importer, `import { x } from './helper.js';\n`, 'utf-8');

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result).toBeUndefined();
  });

  it('相对路径指向目录 index 文件被解析', () => {
    mkdirSync(join(tempDir, 'src', 'lib'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'lib', 'index.ts'), 'export const v = 1;\n', 'utf-8');
    const importer = join(tempDir, 'src', 'handler.ts');
    writeFileSync(importer, `import { v } from './lib';\n`, 'utf-8');

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result).toBeDefined();
    expect(result!.contents).toContain('./lib/index.js');
  });

  it('相对路径文件不存在时 specifier 原样保留', () => {
    const importer = join(tempDir, 'src', 'handler.ts');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(importer, `import { x } from './missing';\n`, 'utf-8');

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result).toBeUndefined();
  });

  it('父目录相对路径（../）被重写为 .js 后缀', () => {
    mkdirSync(join(tempDir, 'src', 'api'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'utils.ts'), 'export const x = 1;\n', 'utf-8');
    const importer = join(tempDir, 'src', 'api', 'handler.ts');
    writeFileSync(importer, `import { x } from '../utils';\n`, 'utf-8');

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result).toBeDefined();
    expect(result!.contents).toContain('../utils.js');
  });

  it('node: 协议 specifier 不被重写', () => {
    const importer = join(tempDir, 'handler.ts');
    writeFileSync(importer, `import { readFileSync } from 'node:fs';\n`, 'utf-8');

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result).toBeUndefined();
  });

  it('别名指向 index 文件时解析为 ./index.js', () => {
    mkdirSync(join(tempDir, 'src', 'lib'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'lib', 'index.ts'), 'export const v = 1;\n');
    const importer = join(tempDir, 'src', 'handler.ts');
    writeFileSync(importer, `import { v } from '@/lib';\n`, 'utf-8');

    const config: TsconfigPathsConfig = {
      baseUrl: tempDir,
      paths: { '@/*': [join(tempDir, 'src/*')] },
    };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result).toBeDefined();
    expect(result!.contents).toContain('./lib/index.js');
  });

  it('动态 import() 中的别名也被重写', () => {
    mkdirSync(join(tempDir, 'src', 'mod'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'mod', 'sub.ts'), 'export const y = 2;\n');
    const importer = join(tempDir, 'src', 'handler.ts');
    writeFileSync(importer, `const mod = await import('@/mod/sub');\n`, 'utf-8');

    const config: TsconfigPathsConfig = {
      baseUrl: tempDir,
      paths: { '@/*': [join(tempDir, 'src/*')] },
    };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result).toBeDefined();
    expect(result!.contents).toContain('./mod/sub.js');
  });
});
