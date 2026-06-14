import { describe, it } from 'vitest';
import { loadPlugins } from './loadPlugins';
import type { PluginContext } from '../config/pluginTypes';

const mockCtx: PluginContext = {
  rootDir: '/tmp/test',
  routes: [],
  server: {} as any,
  config: {},
};

describe('loadPlugins', () => {
  it('空列表不报错', async () => {
    await loadPlugins([], mockCtx);
    await loadPlugins(undefined, mockCtx);
  });

  it('enable: false 的插件跳过', async () => {
    await loadPlugins([{ package: 'nonexistent', enable: false }], mockCtx);
    // 不会抛错（因为 enable: false 跳过了 import）
  });

  it('字符串声明正常解析（不存在的包 warn 不 crash）', async () => {
    await loadPlugins(['nonexistent-package-xyz'], mockCtx);
  });

  it('元组声明带 options（不存在的包 warn 不 crash）', async () => {
    await loadPlugins([['nonexistent-package-xyz', { key: 'value' }]], mockCtx);
  });

  it('重复插件去重（不 crash）', async () => {
    await loadPlugins(['nonexistent-a', 'nonexistent-a'], mockCtx);
  });
});
