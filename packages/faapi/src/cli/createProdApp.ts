import { createAppBase } from './createAppCore';
import type { AppBase, CreateAppOptions } from './createAppCore';

/** prod 应用接口（AppBase，无 reloadRoutes） */
export type ProdApp = AppBase;

// 重新导出 CreateAppOptions 供 createApp.ts 别名使用
export type { CreateAppOptions };

/**
 * prod 模式应用启动 API
 *
 * 直接返回 createAppBase 结果（共享逻辑），不含 dev 专用能力（reloadRoutes、缓存失效）。
 * 产物在 `faapi build` 阶段已固化，运行时不重建。
 *
 * 框架采用零入口设计——用户无需编写 main.ts：
 * - `faapi build` 自动生成 `dist/main.js` 启动入口，内部调用 `createProdApp()` + `listen()` 启动生产服务器
 * - 用户自定义启动逻辑通过 `faapi.config.ts` 的 `lifecycle.onReady` / `onClose` 钩子实现
 *
 * 编程式调用场景（如自定义 CLI 启动器）也可直接调用：
 *
 * @example
 * ```ts
 * import { createProdApp } from '@faapi/faapi';
 * const app = await createProdApp();
 * await app.listen();
 * ```
 */
export async function createProdApp(options?: CreateAppOptions): Promise<ProdApp> {
  const { app } = await createAppBase(options);
  return app;
}
