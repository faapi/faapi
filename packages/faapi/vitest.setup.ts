import { afterEach } from 'vitest';
import { getCurrentApp } from './src/cli/appSingleton';

/**
 * 测试可靠性守卫：app 单例泄漏即失败（在引发用例上报错，不级联）
 *
 * 背景（v7.9.0 发布门禁事故）：一个用例泄漏存活 app 单例后，faapi 单 app 强制
 * 守卫让**后续所有**建 app 的用例连环失败——真凶被淹没在级联里，排查成本高。
 * 本守卫把泄漏的报错定位回引发它的用例。
 *
 * 模式要求（见 AGENTS.md「测试确定性约定」）：任何创建 app 的用例，无论成功、
 * 失败、断言 reject——任何路径都不得把存活 app 带出用例（防御式断言模式）。
 */
afterEach(() => {
  const app = getCurrentApp();
  if (app) {
    throw new Error(
      '[faapi test] 用例结束仍存活 app 单例（单 app 强制守卫会连带打挂后续用例）。' +
        '用例内任何路径都必须 close——预期 reject 的用例请用防御式断言（resolve 路径也要 close）。',
    );
  }
});
