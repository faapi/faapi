import type { AppBase, CreateAppOptions } from './createAppCore';
import { createAppBase } from './createAppCore';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { generateSchemaFiles } from './generateSchemaFiles';
import { invalidateMiddlewareCache } from '../middleware/loadMiddlewares';
import { invalidateProgramCache } from '../ast/createProgram';
import { invalidateSchemaCache } from '../validator/validateInput';
import { setLoadTimestamp } from '../utils/importWithCacheBust';

/** dev 应用接口（AppBase + reloadRoutes 热替换） */
export interface DevApp extends AppBase {
  /** 重新水合路由清单 + 清 schema 缓存 + 更新 server 路由引用（dev 热替换用） */
  reloadRoutes(): Promise<void>;
}

/**
 * dev 模式应用启动 API
 *
 * 在 createAppBase（共享逻辑）基础上增加 `reloadRoutes` 热替换能力，供 `faapi dev` watcher 调用。
 *
 * 与 createProdApp 的区别：
 * - dev：含 reloadRoutes（重新扫描路由 + 重新生成 schema + 清缓存 + 更新 server 路由引用）
 * - prod：精简，无 reloadRoutes（产物已固化，运行时不重建）
 *
 * 由 `devCommand` 直接调用，devCommand 持有 app 引用并传给 watcher。
 *
 * @example
 * ```ts
 * // devCommand 内部
 * const app = await createDevApp();
 * await app.listen();
 * startWatcher({ rootDir, app, devDist });
 * ```
 */
export async function createDevApp(options?: CreateAppOptions): Promise<DevApp> {
  const { app, ctx } = await createAppBase(options);

  const devApp = app as DevApp;

  devApp.reloadRoutes = async (): Promise<void> => {
    // 更新模块加载时间戳（ESM import 绕过缓存）
    setLoadTimestamp(Date.now());
    // 清理缓存（中间件/schema 已被 watcher 重新生成）
    invalidateMiddlewareCache();
    invalidateProgramCache();
    invalidateSchemaCache();
    // 重新扫描路由 + 重新生成 schema
    // 不走 faapi-routes.js 重新 import——ESM 模块缓存难以可靠绕过，直接 scanRoutes 更稳定
    const reScanned = await scanRoutes(ctx.rootDir, ctx.patterns, ctx.dist);
    const sorted = sortRoutes(reScanned.routes);
    await generateSchemaFiles(sorted, ctx.rootDir, ctx.dist);
    // 更新 app 和 server 路由引用
    ctx.updateRoutes(sorted, reScanned.wsRoutes);
  };

  return devApp;
}
