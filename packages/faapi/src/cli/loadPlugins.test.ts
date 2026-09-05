import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPlugins } from './loadPlugins';
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
