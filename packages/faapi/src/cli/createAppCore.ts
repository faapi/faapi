import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { RouteManifest, WsRouteManifest, RoutesRef } from '../router/routeTypes';
import { sortRoutes } from '../router/sortRoutes';
import { detectRouteConflicts } from '../router/detectRouteConflicts';
import { createServer } from '../server/createServer';
import { applyPluginWrappers } from '../server/startServer';
import { loadConfig } from '../config/loadConfig';
import { hydrateRoutes, type SerializedRouteManifest } from './generateRoutes';
import { loadPlugins } from './loadPlugins';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import type { FaapiConfig } from '../config/configTypes';

export interface InjectOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

export interface InjectResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

/** 默认产物目录（prod 模式，对应 `faapi build` 默认输出到 `.faapi/build`） */
const DEFAULT_DIST = '.faapi/build';
/** 默认端口 */
const DEFAULT_PORT = 3000;
/** 路由清单文件名（build/dev 启动时生成） */
const ROUTES_FILE = 'faapi-routes.js';
/** 路由源码目录（写死为 src，路由 .ts 文件位于 src/api/ 下） */
const PATTERNS = ['src/api/**/*.ts'];

/** FaapiConfig 的内置 key 集合（排除自定义业务配置） */
const FAAPI_CONFIG_KEYS = new Set([
  'cors',
  'lifecycle',
  'middlewares',
  'injectors',
  'extendContext',
  'plugins',
  'helmet',
  'bodyLimit',
  'logger',
  'http2',
]);

function isFaapiConfigKey(key: string): boolean {
  return FAAPI_CONFIG_KEYS.has(key);
}

export interface CreateAppOptions {
  /** 项目根目录，默认 process.cwd() */
  rootDir?: string;
  /** 产物输出目录（实际目录，如 .faapi/build 或 .faapi/dev），覆盖环境变量 FAAPI_DIST，默认 '.faapi/build' */
  dist?: string;
  /** 端口号，也可在 listen() 时传入；默认环境变量 PORT 或 3000 */
  port?: number;
}

/** 应用基础接口（dev/prod 共用，不含 reloadRoutes） */
export interface AppBase {
  /** Node.js Server 实例（listen 后可用，close 后置 null） */
  server: Server | null;
  /** 排序后的路由清单 */
  routes: RouteManifest;
  /** WebSocket 路由清单 */
  wsRoutes: WsRouteManifest;
  /** 项目根目录 */
  rootDir: string;
  /** 启动 HTTP server，打印路由表，执行 onReady 钩子 */
  listen(port?: number): Promise<Server>;
  /** 关闭 server，执行 onClose 钩子 */
  close(): Promise<void>;
  /**
   * 无服务器测试注入
   *
   * 构建一个模拟请求直接走完整请求链路，不绑定端口。
   * 需要在 listen() 之前调用（server 未启动时）。
   */
  inject(options?: InjectOptions): Promise<InjectResponse>;
}

/**
 * 内部上下文（供 dev 扩展 reloadRoutes 使用）
 *
 * prod 模式不使用此上下文——createProdApp 直接返回 AppBase。
 */
export interface AppContext {
  /** 项目根目录 */
  rootDir: string;
  /** 产物目录 */
  dist: string;
  /** 扫描 patterns（scanRoutes 用） */
  patterns: string[];
  /** Node.js Server 实例（未 listen） */
  server: Server;
  /** 路由可变引用容器（createServer 闭包和 reloadRoutes 共享） */
  routesRef: RoutesRef;
  /** 配置（原始 FaapiConfig 或 null） */
  config: FaapiConfig | null;
  /**
   * 更新路由引用（app.routes/wsRoutes + routesRef + 闭包变量）
   *
   * dev reloadRoutes 调用此方法把新扫描的路由同步到 app 和 server。
   */
  updateRoutes(routes: RouteManifest, wsRoutes: WsRouteManifest): void;
}

/**
 * 创建应用基础实例（dev/prod 共用逻辑）
 *
 * 完成：配置加载 → 路由清单水合 → 创建 server → 插件加载。
 * 返回 AppBase（listen/close）+ AppContext（供 dev 扩展 reloadRoutes）。
 *
 * dist 由 `process.env.FAAPI_DIST` 决定：
 * - `faapi dev` 启动时设为 `<rootDist>/dev`（默认 `.faapi/dev`）→ 读 dev 产物
 * - `node <rootDist>/build/main` 不设 → 默认 `.faapi/build`，读 prod 产物
 *
 * 不负责编译 TypeScript——编译由 `faapi dev`（esbuild → `<rootDist>/dev/`）和 `faapi build`（→ `<rootDist>/build/`）负责。
 * 不负责生成路由清单——`faapi dev`/`faapi build` 启动时生成 `faapi-routes.js`，createAppBase 直接水合。
 */
export async function createAppBase(options?: CreateAppOptions): Promise<{
  app: AppBase;
  ctx: AppContext;
}> {
  const rootDir = options?.rootDir ?? process.cwd();
  const dist = options?.dist ?? process.env.FAAPI_DIST ?? DEFAULT_DIST;

  // 校验产物存在性
  const routesPath = path.resolve(rootDir, dist, ROUTES_FILE);
  if (!fs.existsSync(routesPath)) {
    throw new Error(
      `[faapi] ${dist}/${ROUTES_FILE} 不存在，请先执行 \`faapi build\`（或 \`faapi dev\`）生成产物。`,
    );
  }

  // 加载配置（统一读 <dist>/faapi-config.js）
  const config = await loadConfig(rootDir, dist);

  // 水合路由清单（统一路径，无 dev/prod 分支）
  const serialized = (await importWithCacheBust(routesPath)) as unknown as SerializedRouteManifest;
  const hydrated = await hydrateRoutes(serialized);
  let sorted = sortRoutes(hydrated.routes);
  let wsRoutes = hydrated.wsRoutes;

  // 检测路由冲突
  const conflicts = detectRouteConflicts(sorted);
  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      console.warn(`! 路由冲突: ${conflict.method} ${conflict.urlPath}`);
      for (const file of conflict.files) {
        console.warn(`  - ${file}`);
      }
    }
  }

  // 自定义业务配置（排除内置 key）
  const pluginConfig: Record<string, unknown> = config
    ? Object.fromEntries(Object.entries(config).filter(([k]) => !isFaapiConfigKey(k)))
    : {};

  // 创建 server（不 listen）
  const { server, routesRef } = createServer({
    routes: sorted,
    rootDir,
    dist,
    cors: config?.cors ?? true,
    onError: config?.lifecycle?.onError,
    config: (config as Record<string, unknown> | null) ?? undefined,
    wsRoutes,
    middlewares: config?.middlewares,
    injectors: config?.injectors,
    helmet: config?.helmet,
    logger: config?.logger,
    bodyLimit: config?.bodyLimit,
    http2: config?.http2,
  });

  // 加载插件 + 应用 handler/upgrade 包装器
  const { handlerWrappers, upgradeWrappers } = await loadPlugins(config?.plugins, {
    rootDir,
    routes: sorted,
    getRoutes: () => sorted,
    server,
    config: pluginConfig,
  });
  applyPluginWrappers(server, handlerWrappers, upgradeWrappers);

  // 关闭状态标记（避免重复关闭）
  let closed = false;

  const app: AppBase = {
    server: null,
    routes: sorted,
    wsRoutes,
    rootDir,

    async listen(listenPort?: number): Promise<Server> {
      // 端口优先级：listen() 参数 > options.port > 环境变量 PORT > 默认 3000
      const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
      const actualPort = listenPort ?? options?.port ?? envPort ?? DEFAULT_PORT;

      return new Promise<Server>((resolve) => {
        server.listen(actualPort, async () => {
          const address = server.address();
          const p = typeof address === 'object' && address !== null ? address.port : actualPort;

          console.log('faapi server started');
          console.log(`- Local: http://localhost:${p}`);
          console.log('- Loaded routes:');
          for (const route of sorted) {
            console.log(`  ${route.method.padEnd(6)}${route.urlPath}  ${route.filePath}`);
          }
          if (wsRoutes.length > 0) {
            console.log('- WebSocket routes:');
            for (const route of wsRoutes) {
              console.log(`  WS     ${route.urlPath}  ${route.filePath}`);
            }
          }

          // 注册优雅关闭信号（仅当配置了 onClose）
          if (config?.lifecycle?.onClose) {
            const graceful = async (signal: string): Promise<void> => {
              console.log(`\n- Received ${signal}, shutting down...`);
              await app.close();
              process.exit(0);
            };
            process.on('SIGTERM', () => void graceful('SIGTERM'));
            process.on('SIGINT', () => void graceful('SIGINT'));
          }

          // onReady 生命周期钩子
          if (config?.lifecycle?.onReady) {
            await config.lifecycle.onReady({ rootDir, routes: sorted, server });
            console.log('- onReady hook executed');
          }

          app.server = server;
          resolve(server);
        });
      });
    },

    async inject(injectOpts?: InjectOptions): Promise<InjectResponse> {
      const {
        method = 'GET',
        path: reqPath = '/',
        headers: reqHeaders = {},
        query,
        body,
      } = injectOpts ?? {};

      const queryStr = query
        ? '?' +
          new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()
        : '';

      return new Promise<InjectResponse>((resolve, reject) => {
        const mockRes = {
          statusCode: 200,
          _headers: {} as Record<string, string>,
          _body: Buffer.alloc(0) as Buffer,
          setHeader(name: string, value: string) {
            this._headers[name.toLowerCase()] = value;
          },
          appendHeader(name: string, value: string) {
            const key = name.toLowerCase();
            const existing = this._headers[key];
            this._headers[key] = existing ? `${existing}, ${value}` : value;
          },
          writeHead(status: number, headers?: Record<string, string>) {
            this.statusCode = status;
            if (headers) {
              Object.assign(this._headers, headers);
            }
          },
          end(data?: string | Buffer) {
            const buf: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data ?? '');
            this._body = buf;
            resolve({
              status: this.statusCode,
              headers: new Headers(this._headers as Record<string, string>),
              body: this.parseBody(),
            });
          },
          parseBody(): unknown {
            try {
              return JSON.parse(this._body.toString());
            } catch {
              return this._body.toString();
            }
          },
        };

        const listeners = server.listeners('request');
        const handler = listeners[listeners.length - 1];
        if (typeof handler !== 'function') {
          reject(new Error('No request handler found'));
          return;
        }

        const mockReq: PassThrough & {
          method?: string;
          url?: string;
          headers?: Record<string, string | undefined>;
          socket?: { remoteAddress?: string };
        } = new PassThrough({
          read() {
            this.push(null);
          },
        });
        mockReq.method = method;
        mockReq.url = `${reqPath}${queryStr}`;
        mockReq.headers = {
          ...reqHeaders,
          host: 'localhost',
          'content-type': body !== undefined ? 'application/json' : undefined,
        };
        mockReq.socket = { remoteAddress: '127.0.0.1' };
        if (body !== undefined) {
          mockReq.push(JSON.stringify(body));
        }

        handler(
          mockReq as unknown as import('node:http').IncomingMessage,
          mockRes as unknown as import('node:http').ServerResponse,
        );
      });
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;

      // 停止接受新连接（HTTP/2 server 支持，HTTP/1.1 无此方法）
      const s = server as unknown as Record<string, unknown>;
      if (typeof s.closeIdleConnections === 'function') {
        (s.closeIdleConnections as () => void)();
      }
      if (typeof s.closeAllConnections === 'function') {
        (s.closeAllConnections as () => void)();
      }

      if (config?.lifecycle?.onClose) {
        await config.lifecycle.onClose({ rootDir, routes: sorted, server });
      }

      return new Promise<void>((resolve) => {
        server.close((err) => {
          if (err) console.error('Error closing server:', err);
          app.server = null;
          resolve();
        });
      });
    },
  };

  /** 更新路由引用（app + routesRef + 闭包变量） */
  const ctx: AppContext = {
    rootDir,
    dist,
    patterns: PATTERNS,
    server,
    routesRef,
    config,
    updateRoutes(newRoutes: RouteManifest, newWsRoutes: WsRouteManifest): void {
      sorted = newRoutes;
      wsRoutes = newWsRoutes;
      app.routes = newRoutes;
      app.wsRoutes = newWsRoutes;
      routesRef.current = newRoutes;
      routesRef.wsCurrent = newWsRoutes;
    },
  };

  return { app, ctx };
}
