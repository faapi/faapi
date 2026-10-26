import { createProdApp } from './createProdApp';
import type { AppBase } from './createAppCore';

/**
 * $ 前缀 = 框架内部标记：**仅供生成的 `dist/main.js` 使用**（`faapi build` 生成），
 * 业务不应直接调用——零入口是唯一入口，启动逻辑写 `src/bootstrap.ts`
 * （见 [bootstrap](./bootstrap.md)）。
 *
 * 完整启动：createProdApp（产物水合 + bootstrap 执行）→ listen。
 */
export interface StartOptions {
  /** 产物输出目录（默认 `dist`；`faapi build --dist` 非默认时由生成模板传入） */
  dist?: string;
}

/**
 * 零入口 prod 启动（生成入口专用）
 *
 * 内部流程：`createProdApp`（产物水合 + bootstrap 执行；bootstrap/订阅端抛错时
 * reject 且不 listen）→ `listen()` → 返回 app（`getApp()` 此后可用）。
 */
export async function $start(options?: StartOptions): Promise<AppBase> {
  const app = await createProdApp(options);
  await app.listen();
  return app;
}
