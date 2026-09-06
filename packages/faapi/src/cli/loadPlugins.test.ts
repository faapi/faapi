import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPlugins, resolveLocalPluginSource } from './loadPlugins';
import { compileProjectModules } from './compileConfig';
import { setDevOnDemandEnabled, setDevDist, _resetDevOnDemandState } from './compileOnDemand';
import { createAppRegistries } from '../injection/registries';
import type { PluginContext } from '../config/pluginTypes';

const mockCtx: PluginContext = {
  rootDir: '/tmp/test',
  registries: createAppRegistries(),
  routes: [],
  getRoutes: () => [],
  server: {} as any,
  config: {},
};

describe('loadPlugins', () => {
  it('空列表不报错', async () => {
    await loadPlugins([], mockCtx);
    await loadPlugins(undefined, mockCtx);
  });

  it('enable: false 的插件跳过', async () => {
    const { failures } = await loadPlugins([{ package: 'nonexistent', enable: false }], mockCtx);
    // enable: false 跳过 import，不进 failures
    expect(failures).toEqual([]);
  });

  it('加载失败的插件进入 failures（不再纯静默 warn）', async () => {
    const { failures } = await loadPlugins(['nonexistent-package-xyz'], mockCtx);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.specifier).toBe('nonexistent-package-xyz');
    expect(failures[0]!.reason).toBeTruthy();
  });

  it('非法声明进 failures 而非崩掉启动', async () => {
    const { failures } = await loadPlugins(
      [{ foo: 'bar' } as unknown as NonNullable<Parameters<typeof loadPlugins>[0]>[number]],
      mockCtx,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]!.specifier).toContain('foo');
    expect(failures[0]!.reason).toContain('Invalid plugin declaration');
  });

  it('setup 缺失的插件进 failures', async () => {
    const tempDir = join(tmpdir(), `faapi-plugins-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'no-setup.js'), `export default { name: 'no-setup' };\n`);
    try {
      const { failures } = await loadPlugins([{ path: './no-setup.js' }], mockCtx, tempDir);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.reason).toContain('no setup function');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('path 声明相对项目根目录解析（此前相对 faapi 包产物解析，必然失败）', async () => {
    const tempDir = join(tmpdir(), `faapi-plugins-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, 'my-plugin.js'),
      `export default { name: 'my-plugin', setup() { globalThis.__faapiPluginRan = true; } };\n`,
    );
    try {
      const { failures } = await loadPlugins([{ path: './my-plugin.js' }], mockCtx, tempDir);
      expect(failures).toEqual([]);
      expect((globalThis as unknown as Record<string, boolean>).__faapiPluginRan).toBe(true);
    } finally {
      delete (globalThis as unknown as Record<string, boolean>).__faapiPluginRan;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('单个插件失败不影响后续插件加载', async () => {
    const tempDir = join(tmpdir(), `faapi-plugins-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, 'good.js'),
      `export default { name: 'good', setup() { globalThis.__faapiGoodPlugin = true; } };\n`,
    );
    try {
      const { failures } = await loadPlugins(
        ['nonexistent-package-xyz', { path: './good.js' }],
        mockCtx,
        tempDir,
      );
      expect(failures).toHaveLength(1);
      expect((globalThis as unknown as Record<string, boolean>).__faapiGoodPlugin).toBe(true);
    } finally {
      delete (globalThis as unknown as Record<string, boolean>).__faapiGoodPlugin;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('元组声明带 options（不存在的包进 failures）', async () => {
    const { failures } = await loadPlugins(
      [['nonexistent-package-xyz', { key: 'value' }]],
      mockCtx,
    );
    expect(failures).toHaveLength(1);
  });

  it('重复插件去重（不 crash，失败只记一次）', async () => {
    const { failures } = await loadPlugins(['nonexistent-a', 'nonexistent-a'], mockCtx);
    expect(failures).toHaveLength(1);
  });
});

/**
 * 本地 TS 插件（`{ path: './plugins/xxx' }`，.ts 源码）
 *
 * 背景：Node ESM 对 file URL 不做扩展名补全，无扩展名声明直接 import 必然
 * `Cannot find module`——此前本地 TS 插件无论 dev/prod 均无法加载，且失败
 * 静默（GAP-1）。现在：探测源文件 → 产物 fresh 直接复用 → dev 按需编译 →
 * prod stale 明确报错指引 faapi build。
 */
describe('loadPlugins 本地 TS 插件', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-plugins-ts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(tempDir, 'plugins'), { recursive: true });
    mkdirSync(join(tempDir, 'src', 'lib'), { recursive: true });
    // src 内依赖：插件 import 无扩展名（探测/重写由框架负责）
    writeFileSync(
      join(tempDir, 'src', 'lib', 'helper.ts'),
      `export function greet() { return 'hello-from-src'; }\n`,
      'utf-8',
    );
    writeFileSync(
      join(tempDir, 'plugins', 'local-plugin.ts'),
      `import { greet } from '../src/lib/helper';
export default {
  name: 'local-plugin',
  setup() {
    (globalThis as Record<string, unknown>).__localPluginGreeting = greet();
  },
};
`,
      'utf-8',
    );
  });

  afterEach(() => {
    _resetDevOnDemandState();
    delete (globalThis as unknown as Record<string, unknown>).__localPluginGreeting;
    delete (globalThis as unknown as Record<string, unknown>).__innerPluginRan;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('dev 按需编译：无扩展名 path 声明的 .ts 插件被编译并加载（含 src 内依赖）', async () => {
    setDevOnDemandEnabled(true);
    setDevDist('.faapi');

    const { failures } = await loadPlugins(
      [{ path: './plugins/local-plugin' }],
      mockCtx,
      tempDir,
      '.faapi',
    );

    expect(failures).toEqual([]);
    // 插件 setup 执行且 src 内依赖（无扩展名 import）可用
    expect((globalThis as unknown as Record<string, unknown>).__localPluginGreeting).toBe(
      'hello-from-src',
    );
    // 产物落在 <dist>/plugins/ 下（保留相对结构）
    expect(existsSync(join(tempDir, '.faapi', 'plugins', 'local-plugin.js'))).toBe(true);
    // src 内依赖闭包一并编译（打平结构，与 routes 产物同一）
    expect(existsSync(join(tempDir, '.faapi', 'lib', 'helper.js'))).toBe(true);
  });

  it('index 文件探测：./plugins/local-plugin 指向目录时解析 /index.ts', async () => {
    setDevOnDemandEnabled(true);
    setDevDist('.faapi');
    rmSync(join(tempDir, 'plugins', 'local-plugin.ts'), { force: true });
    mkdirSync(join(tempDir, 'plugins', 'local-plugin'), { recursive: true });
    writeFileSync(
      join(tempDir, 'plugins', 'local-plugin', 'index.ts'),
      `export default { name: 'local-plugin', setup() {} };\n`,
      'utf-8',
    );

    const { failures } = await loadPlugins(
      [{ path: './plugins/local-plugin' }],
      mockCtx,
      tempDir,
      '.faapi',
    );
    expect(failures).toEqual([]);
  });

  it('prod 模式：build 固化产物后直接 import 产物', async () => {
    // 模拟 build 步骤 2.5：编译本地插件到 dist
    await compileProjectModules([join(tempDir, 'plugins', 'local-plugin.ts')], tempDir, 'dist');

    const { failures } = await loadPlugins(
      [{ path: './plugins/local-plugin' }],
      mockCtx,
      tempDir,
      'dist',
    );

    expect(failures).toEqual([]);
    expect((globalThis as unknown as Record<string, unknown>).__localPluginGreeting).toBe(
      'hello-from-src',
    );
  });

  it('prod 模式产物 stale 时报错并指引 faapi build（不静默用旧产物）', async () => {
    await compileProjectModules([join(tempDir, 'plugins', 'local-plugin.ts')], tempDir, 'dist');
    // 源码 mtime 晚于产物（改了源码没重新 build）
    const later = new Date(Date.now() + 10_000);
    utimesSync(join(tempDir, 'plugins', 'local-plugin.ts'), later, later);

    const { failures } = await loadPlugins(
      [{ path: './plugins/local-plugin' }],
      mockCtx,
      tempDir,
      'dist',
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toContain('faapi build');
  });

  it('探测失败时 failures 带候选文件与修复指引', async () => {
    const { failures } = await loadPlugins(
      [{ path: './plugins/nope' }],
      mockCtx,
      tempDir,
      '.faapi',
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toContain('Cannot find local plugin');
    expect(failures[0]!.reason).toContain(join(tempDir, 'plugins', 'nope.ts'));
  });

  it('src 内插件走打平产物（与 routes 同一运行时对象）', async () => {
    setDevOnDemandEnabled(true);
    setDevDist('.faapi');
    mkdirSync(join(tempDir, 'src', 'plugins'), { recursive: true });
    writeFileSync(
      join(tempDir, 'src', 'plugins', 'inner-plugin.ts'),
      `export default {
  name: 'inner-plugin',
  setup() { (globalThis as Record<string, unknown>).__innerPluginRan = true; },
};
`,
      'utf-8',
    );

    const { failures } = await loadPlugins(
      [{ path: './src/plugins/inner-plugin' }],
      mockCtx,
      tempDir,
      '.faapi',
    );

    expect(failures).toEqual([]);
    expect((globalThis as unknown as Record<string, unknown>).__innerPluginRan).toBe(true);
    // src 内产物打平前缀（去 src/），与 compileDevRoutes 产物路径一致
    expect(existsSync(join(tempDir, '.faapi', 'plugins', 'inner-plugin.js'))).toBe(true);
  });

  it('resolveLocalPluginSource 探测顺序：原样 → .ts → .js → /index.ts', () => {
    expect(resolveLocalPluginSource('./plugins/local-plugin', tempDir)).toBe(
      join(tempDir, 'plugins', 'local-plugin.ts'),
    );
    expect(resolveLocalPluginSource('./plugins/local-plugin.ts', tempDir)).toBe(
      join(tempDir, 'plugins', 'local-plugin.ts'),
    );
    expect(resolveLocalPluginSource('./plugins/missing', tempDir)).toBeNull();
  });
});
