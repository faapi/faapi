import type { AppBase } from './createAppCore';

/**
 * app 单例与默认停机信号处理
 *
 * 从 createAppCore 拆出的进程级状态——与编排逻辑正交：单例解决「拿不到 app 引用」
 * 的场景（Next.js Server Component 经 getApp() 拿实例），信号处理解决「进程停机
 * 入口」。AppBase 为 type-only 导入（编译期擦除，无运行时循环依赖）。
 */

/**
 * 当前 app 单例的 globalThis key
 *
 * 用 `Symbol.for` 创建全局 symbol，确保跨模块实例共享同一个 key——
 * Next.js 16 默认用 Turbopack 作为 `next dev` 的 bundler，Turbopack dev server runtime
 * 与主进程的 Node.js 原生 module cache 是两套独立缓存，用模块级变量无法跨实例共享，
 * 必须借助 `globalThis`。
 *
 * 注：生产模式（`node dist/main` + `next build`）不受此问题影响——`next build` 产物是
 * 普通 JS 文件，运行时通过 Node.js 原生 require 加载，与主进程共享 module cache。
 * 此机制主要解决 dev 模式下 RSC 调用 `getApp()` 的问题，对生产模式无副作用。
 */
const APP_INSTANCE_KEY = Symbol.for('faapi.app.instance');

/**
 * 读取当前 app 单例（从 globalThis 取，跨模块实例共享）
 *
 * 注意：单例仅指向"最近一次创建且未关闭的 app"。测试场景下创建多个临时 app 时，
 * 单例会被覆盖，但 close 时只有当单例仍指向当前 app 才置 null，避免被后续 app 误清。
 */
export function getCurrentApp(): AppBase | null {
  return (globalThis as Record<symbol, AppBase | undefined>)[APP_INSTANCE_KEY] ?? null;
}

/** 设置/清除当前 app 单例（写入 globalThis，跨模块实例共享） */
export function setCurrentApp(app: AppBase | null): void {
  if (app === null) {
    delete (globalThis as Record<symbol, AppBase | undefined>)[APP_INSTANCE_KEY];
  } else {
    (globalThis as Record<symbol, AppBase | undefined>)[APP_INSTANCE_KEY] = app;
  }
}

/** 默认优雅关闭信号 handler 是否已安装（写入 globalThis，跨模块实例共享） */
const SHUTDOWN_INSTALLED_KEY = Symbol.for('faapi.defaultShutdownInstalled');

/**
 * 注册默认优雅关闭信号（SIGTERM/SIGINT，进程级仅注册一次）
 *
 * 收到信号时关闭当前 app 单例（app.close() 内部完成 drain + onClose 钩子 +
 * 注册表清理）后退出。faapi 单进程单 app 设计——单例即唯一运行中的 app；
 * 测试场景多次 listen 不会堆积 process 监听器（globalThis 标记防重装）。
 */
export function registerDefaultShutdownHandlers(): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[SHUTDOWN_INSTALLED_KEY]) return;
  g[SHUTDOWN_INSTALLED_KEY] = true;

  const shutdown = (signal: string): void => {
    console.log(`\n- Received ${signal}, shutting down...`);
    void (async () => {
      const app = getCurrentApp();
      if (app) await app.close();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * 获取当前 faapi app 单例
 *
 * 用于在无法直接拿到 app 引用的场景（如 Next.js Server Component）中访问 app。
 *
 * 通过 `globalThis` 共享单例，确保 Next.js 16 Turbopack dev server runtime 加载的
 * `@faapi/faapi` 模块实例与主进程 `faapi dev` 设置单例的实例能读到同一个 app 引用。
 *
 * @returns 当前 app 实例
 * @throws 未初始化时抛错（需先调 `createProdApp()` / `createDevApp()`，或 `faapi dev` / `node dist/main` 启动）
 *
 * @example
 * ```ts
 * // Next.js RSC 中调用 faapi API（同进程，跳过 HTTP loopback）
 * import { getApp } from '@faapi/faapi';
 * import { headers } from 'next/headers';
 *
 * const app = getApp();
 * const h = await headers();
 * const res = await app.inject({
 *   method: 'GET',
 *   path: '/api/user',
 *   headers: { cookie: h.get('cookie') ?? '', authorization: h.get('authorization') ?? '' },
 * });
 * const data = res.body;  // 已解析
 * ```
 */
export function getApp(): AppBase {
  const app = getCurrentApp();
  if (!app) {
    throw new Error(
      '[faapi] No app instance. Call createProdApp() / createDevApp() first, or run `faapi dev` / `node dist/main`.',
    );
  }
  return app;
}
