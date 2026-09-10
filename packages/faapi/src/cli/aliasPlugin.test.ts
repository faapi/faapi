import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  toProdExtension,
  createAliasPlugin,
  buildAliasPlugins,
  resolveRelativeSpecifier,
} from './aliasPlugin';
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
    let captured:
      | {
          contents?: string;
          loader?: string;
          errors?: Array<{
            text: string;
            location?: { file: string; line?: number; column?: number; lineText?: string };
          }>;
        }
      | undefined;
    const build = {
      onLoad(_filter: unknown, cb: (args: { path: string }) => unknown) {
        captured = cb({ path: filePath }) as typeof captured;
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

  it('相对路径文件不存在时 onLoad 返回构建错误（不静默保留）', () => {
    const importer = join(tempDir, 'src', 'handler.ts');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(importer, `import { x } from './missing';\n`, 'utf-8');

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result?.errors).toHaveLength(1);
    expect(result?.errors?.[0]?.text).toContain('./missing');
    expect(result?.errors?.[0]?.text).toContain('无法解析的相对导入');
  });

  it('构建错误定位到导入所在 file:line 与源码行文本', () => {
    const importer = join(tempDir, 'src', 'handler.ts');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(importer, `export const a = 1;\nimport { x } from './missing';\n`, 'utf-8');

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    const loc = result?.errors?.[0]?.location;
    expect(loc?.file).toBe(importer);
    expect(loc?.line).toBe(2);
    expect(loc?.lineText).toContain('./missing');
  });

  it('多个不可解析相对导入逐个报错', () => {
    const importer = join(tempDir, 'src', 'handler.ts');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(
      importer,
      `import { a } from './missing-a';\nimport { b } from './missing-b';\n`,
      'utf-8',
    );

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result?.errors).toHaveLength(2);
    expect(result?.errors?.map((e) => e.text).join('\n')).toContain('./missing-a');
    expect(result?.errors?.map((e) => e.text).join('\n')).toContain('./missing-b');
  });

  it('.js 说明符仅 .ts 源存在时保持不变（Node16 风格，不报错）', () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'helper.ts'), 'export const x = 1;\n', 'utf-8');
    const importer = join(tempDir, 'src', 'handler.ts');
    writeFileSync(importer, `import { x } from './helper.js';\n`, 'utf-8');

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result).toBeUndefined();
  });

  it('注释中的 import 不参与重写与报错（AST 定位）', () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'helper.ts'), 'export const x = 1;\n', 'utf-8');
    const importer = join(tempDir, 'src', 'handler.ts');
    writeFileSync(
      importer,
      `// import { old } from './removed-module';\nimport { x } from './helper';\n`,
      'utf-8',
    );

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result?.errors).toBeUndefined();
    expect(result?.contents).toContain('./helper.js');
    // 注释原样保留，不被改写
    expect(result?.contents).toContain(`// import { old } from './removed-module';`);
  });

  it('字符串字面量中的 from 不参与重写与报错', () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'helper.ts'), 'export const x = 1;\n', 'utf-8');
    const importer = join(tempDir, 'src', 'handler.ts');
    writeFileSync(
      importer,
      `export const tip = "usage: import { y } from './missing';";\nimport { x } from './helper';\n`,
      'utf-8',
    );

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result?.errors).toBeUndefined();
    expect(result?.contents).toContain('./helper.js');
    // 字符串内容原样保留
    expect(result?.contents).toContain(`usage: import { y } from './missing';`);
  });

  it('副作用导入 import ./x 被重写为 .js 后缀', () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'register.ts'), 'export {};\n', 'utf-8');
    const importer = join(tempDir, 'src', 'handler.ts');
    writeFileSync(importer, `import './register';\n`, 'utf-8');

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result?.errors).toBeUndefined();
    expect(result?.contents).toContain('./register.js');
  });

  it('import type 被编译器擦除，说明符不存在也不报错', () => {
    const importer = join(tempDir, 'src', 'handler.ts');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(
      importer,
      `import type { Middleware } from '../../index';\nexport const x = 1;\n`,
      'utf-8',
    );

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result?.errors).toBeUndefined();
  });

  it('export type from 同样不参与重写与报错', () => {
    const importer = join(tempDir, 'src', 'handler.ts');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(
      importer,
      `export type { Missing } from './missing-types';\nexport const x = 1;\n`,
      'utf-8',
    );

    const config: TsconfigPathsConfig = { baseUrl: '.', paths: {} };
    const result = applyOnLoad(createAliasPlugin(config), importer);
    expect(result?.errors).toBeUndefined();
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

  it('src 外 importer（rootDir 根，config 场景）引用 src 内模块时剥离 src/ 前缀', () => {
    mkdirSync(join(tempDir, 'src', 'lib'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'lib', 'errors.ts'), 'export class E {}\n');
    writeFileSync(
      join(tempDir, 'faapi.config.ts'),
      `import { E } from './src/lib/errors';\n`,
      'utf-8',
    );
    // esbuild onLoad 传入的 args.path 是 realpath（macOS /var → /private/var）
    const importer = realpathSync(join(tempDir, 'faapi.config.ts'));

    const result = applyOnLoad(buildAliasPlugins(tempDir)[0]!, importer);
    expect(result).toBeDefined();
    // 产物在 dist 根（faapi.config.js），相对 import 不带回退前缀
    expect(result!.contents).toContain('./lib/errors.js');
  });

  it('src 外子目录 importer（本地插件场景）引用 src 内模块时剥离前缀并回退 ../', () => {
    mkdirSync(join(tempDir, 'plugins'), { recursive: true });
    mkdirSync(join(tempDir, 'src', 'lib'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'lib', 'errors.ts'), 'export class E {}\n');
    writeFileSync(
      join(tempDir, 'plugins', 'db-skills.ts'),
      `import { E } from '../src/lib/errors';\n`,
      'utf-8',
    );
    // esbuild onLoad 传入的 args.path 是 realpath（macOS /var → /private/var）
    const importer = realpathSync(join(tempDir, 'plugins', 'db-skills.ts'));

    const result = applyOnLoad(buildAliasPlugins(tempDir)[0]!, importer);
    expect(result).toBeDefined();
    // 产物在 dist 子目录（plugins/db-skills.js），相对 dist 根的剥离路径需回退一级
    expect(result!.contents).toContain("from '../lib/errors.js'");
  });
});

describe('resolveRelativeSpecifier', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-alias-resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('无后缀 specifier 命中 .ts 源文件', () => {
    writeFileSync(join(tempDir, 'helper.ts'), 'export const x = 1;\n', 'utf-8');
    expect(resolveRelativeSpecifier(join(tempDir, 'handler.ts'), './helper')).toBe(
      join(tempDir, 'helper.ts'),
    );
  });

  it('.js 说明符且 .js 文件存在 → 返回该文件', () => {
    writeFileSync(join(tempDir, 'helper.js'), 'export const x = 1;\n', 'utf-8');
    expect(resolveRelativeSpecifier(join(tempDir, 'handler.ts'), './helper.js')).toBe(
      join(tempDir, 'helper.js'),
    );
  });

  it('.js 说明符仅 .ts 源存在 → 回退返回 .ts 源路径（产物必有 .js，不报错）', () => {
    writeFileSync(join(tempDir, 'helper.ts'), 'export const x = 1;\n', 'utf-8');
    expect(resolveRelativeSpecifier(join(tempDir, 'handler.ts'), './helper.js')).toBe(
      join(tempDir, 'helper.ts'),
    );
  });

  it('.js 说明符指向目录 index（仅 index.ts）→ 回退返回 index 源路径', () => {
    mkdirSync(join(tempDir, 'lib'), { recursive: true });
    writeFileSync(join(tempDir, 'lib', 'index.ts'), 'export const x = 1;\n', 'utf-8');
    expect(resolveRelativeSpecifier(join(tempDir, 'handler.ts'), './lib/index.js')).toBe(
      join(tempDir, 'lib', 'index.ts'),
    );
  });

  it('目标完全不存在 → null', () => {
    expect(resolveRelativeSpecifier(join(tempDir, 'handler.ts'), './missing')).toBeNull();
    expect(resolveRelativeSpecifier(join(tempDir, 'handler.ts'), './missing.js')).toBeNull();
  });
});
