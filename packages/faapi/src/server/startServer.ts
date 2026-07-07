import type { Server } from 'node:http';
import type { RouteManifest, WsRouteManifest } from '../router/routeTypes';
import type { CorsOptions } from '../middleware/cors';
import type { FaapiContext } from '../runtime/contextTypes';
import type { FaapiMiddleware } from '../middleware/middlewareTypes';
import type { InjectorMap } from '../middleware/injectorTypes';
import type { RequestHandler, UpgradeHandler } from '../config/pluginTypes';
import { createServer } from './createServer';

export interface StartOptions {
  port: number;
  routes: RouteManifest;
  rootDir: string;
  /** 产物输出目录（如 '.faapi/dev' 或 '.faapi/build'），用于计算 schema 路径 */
  dist: string;
  cors?: CorsOptions | boolean;
  /** 请求错误钩子（在错误响应生成后调用，用于副作用，不修改已发出的响应） */
  onError?: (error: unknown, ctx: FaapiContext) => Promise<void> | void;
  /** 自定义业务配置（来自 faapi.config.ts，注入到 ctx.config） */
  config?: Record<string, unknown>;
  /** WebSocket 路由清单 */
  wsRoutes?: WsRouteManifest;
  /** 全局中间件（来自 faapi.config.ts，对所有路由生效，最外层） */
  middlewares?: FaapiMiddleware[];
  /** 全局注入器（来自 faapi.config.ts，对所有路由 handler 参数注入生效） */
  injectors?: InjectorMap;
  /**
   * server.listen 之前的钩子（用于加载插件、应用 handler 包装等）
   *
   * 钩子在 server 创建后、listen 之前调用，可修改 server 的 request/upgrade listener。
   */
  beforeListen?: (server: Server) => Promise<void> | void;
}

/**
 * 启动 HTTP server 并打印路由表
 *
 * 流程：createServer → beforeListen（可选，加载插件/应用包装）→ listen → 打印路由表
 */
export function startServer(options: StartOptions): Promise<Server> {
  const {
    port,
    routes,
    rootDir,
    dist,
    cors,
    onError,
    config,
    wsRoutes,
    middlewares,
    injectors,
    beforeListen,
  } = options;
  const { server } = createServer({
    routes,
    rootDir,
    dist,
    cors,
    onError,
    config,
    wsRoutes,
    middlewares,
    injectors,
  });

  return (async () => {
    // beforeListen 钩子：加载插件、应用 handler 包装等
    if (beforeListen) {
      await beforeListen(server);
    }

    return new Promise<Server>((resolve) => {
      server.listen(port, () => {
        const address = server.address();
        const actualPort = typeof address === 'object' && address !== null ? address.port : port;

        console.log('faapi dev server started');
        console.log(`- Local: http://localhost:${actualPort}`);
        console.log('- Loaded routes:');

        for (const route of routes) {
          const method = route.method.padEnd(6);
          console.log(`  ${method}${route.urlPath}  ${route.filePath}`);
        }

        if (wsRoutes && wsRoutes.length > 0) {
          console.log('- WebSocket routes:');
          for (const route of wsRoutes) {
            console.log(`  WS     ${route.urlPath}  ${route.filePath}`);
          }
        }

        resolve(server);
      });
    });
  })();
}

/**
 * 应用 handler / upgrade 包装器到 server
 *
 * 在 server.listen 之前调用，替换 server 的 request/upgrade listener。
 * 包装器按数组顺序嵌套：finalHandler = wrap1(wrap2(originalHandler))。
 *
 * @param server 目标 server（未 listen）
 * @param handlerWrappers HTTP handler 包装器数组
 * @param upgradeWrappers WS upgrade handler 包装器数组
 */
export function applyPluginWrappers(
  server: Server,
  handlerWrappers: Array<(original: RequestHandler) => RequestHandler>,
  upgradeWrappers: Array<(original: UpgradeHandler | undefined) => UpgradeHandler>,
): void {
  // 应用 HTTP handler 包装
  if (handlerWrappers.length > 0) {
    const listeners = server.listeners('request');
    const original = listeners[0] as RequestHandler | undefined;
    if (original) {
      server.removeAllListeners('request');
      let handler: RequestHandler = original;
      for (const wrap of handlerWrappers) {
        handler = wrap(handler);
      }
      server.on('request', handler);
    }
  }

  // 应用 WS upgrade handler 包装
  if (upgradeWrappers.length > 0) {
    const listeners = server.listeners('upgrade');
    const original = listeners[0] as UpgradeHandler | undefined;
    server.removeAllListeners('upgrade');
    let upgrade: UpgradeHandler | undefined = original;
    for (const wrap of upgradeWrappers) {
      upgrade = wrap(upgrade);
    }
    if (upgrade) {
      server.on('upgrade', upgrade);
    }
  }
}
