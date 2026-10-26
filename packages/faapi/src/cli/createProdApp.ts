import { createAppBase } from './createAppCore';
import type { AppBase, CreateAppOptions } from './createAppCore';
import { loadBootstrap } from './bootstrap';

/** prod 应用接口（AppBase，无 reloadRoutes） */
export type ProdApp = AppBase;

// 重新导出 CreateAppOptions 供 $start 使用
export type { CreateAppOptions };

/**
 * prod 模式应用启动（**框架内部模块——不公开导出**）
 *
 * 仅供生成的 `dist/main.js`（经 `$start`）与 CLI 编排使用，业务不应直接调用——
 * 零入口是唯一入口，启动逻辑写 `src/bootstrap.ts`（见 [bootstrap](./bootstrap.md)）。
 *
 * 直接返回 createAppBase 结果（共享逻辑），不含 dev 专用能力（reloadRoutes、缓存失效）。
 * 产物在 `faapi build` 阶段已固化，运行时不重建。返回前加载执行
 * `src/bootstrap.ts`（app 已创建、事件未发射——bootstrap 订阅窗口，见 bootstrap.md）。
 */
export async function createProdApp(options?: CreateAppOptions): Promise<ProdApp> {
  const { app, ctx } = await createAppBase(options);
  try {
    await loadBootstrap(ctx.rootDir, ctx.dist);
  } catch (err) {
    // bootstrap 失败的 app 不可用：清理单例与注册表后上抛（可修复重建，不留孤儿单例）
    await app.close();
    throw err;
  }
  return app;
}
