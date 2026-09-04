import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { RouteManifest, WsRouteManifest, RoutesRef } from '../router/routeTypes';
import { sortRoutes } from '../router/sortRoutes';
import { detectRouteConflicts } from '../router/detectRouteConflicts';
import { createServer } from '../server/createServer';
import { applyPluginWrappers } from '../server/startServer';
import { loadConfig } from '../config/loadConfig';
import { hydrateRoutes, type SerializedRouteManifest } from './generateRoutes';
import { hydrateTools, type SerializedToolRecord } from './generateToolArtifacts';
import { hydrateAgents, type SerializedAgentRecord } from './generateAgentArtifacts';
import { loadPlugins } from './loadPlugins';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import { hydrateToolRegistry, clearToolRegistry } from '../injection/toolRegistry';
import { hydrateAgentRegistry, clearAgentRegistry } from '../injection/agentRegistry';
import { clearSkillRegistry } from '../injection/skillRegistry';
import { clearAgentHandleFactory } from '../injection/agentHandle';
import type { ToolMetadata } from '../ast/extractToolMetadata';
import type { AgentMetadata } from '../ast/extractAgentMetadata';
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

/** 默认产物目录（prod 模式，对应 `faapi build` 默认输出到 `dist`） */
const DEFAULT_DIST = 'dist';
/** 默认端口 */
const DEFAULT_PORT = 3000;
/** 路由清单文件名（build/dev 启动时生成，必需产物） */
const ROUTES_FILE = 'faapi-routes.js';
/** tool 清单文件名（build/dev 启动时生成，可选产物——无 tool 的项目不生成） */
const TOOLS_FILE = 'faapi-tools.js';
/** agent 清单文件名（build/dev 启动时生成，可选产物——无 agent 的项目不生成） */
const AGENTS_FILE = 'faapi-agents.js';
/** 路由源码目录（写死为 src，路由 .ts 文件位于 src/api/ 下） */
const PATTERNS = ['src/api/**/*.ts'];

/**
 * 加载 faapi-tools.js 并水合到 toolRegistry（单例）
 *
 * 与路由清单不同，tool 是可选能力——纯 API 项目可能没有 `faapi-tools.js`，
 * 此时不报错，返回空数组，toolRegistry 保持空。
 *
 * dev 按需模式下 `reloadTools` 也会调用此函数重新水合（`setLoadTimestamp` 已在外层设置）。
 *
 * @returns 水合后的 ToolMetadata[]（供调用方日志/调试）
 */
export async function loadAndHydrateTools(rootDir: string, dist: string): Promise<ToolMetadata[]> {
  const toolsPath = path.resolve(rootDir, dist, TOOLS_FILE);
  if (!fs.existsSync(toolsPath)) {
    return [];
  }
  const serialized = (await importWithCacheBust(toolsPath)) as unknown as {
    tools: SerializedToolRecord[];
  };
  const hydrated = hydrateTools(serialized.tools ?? []);
  hydrateToolRegistry(hydrated);
  return hydrated;
}

/**
 * 加载 faapi-agents.js 并水合到 agentRegistry（单例）
 *
 * 与 `loadAndHydrateTools` 对称——agent 是可选能力,纯 API 项目可能没有 `faapi-agents.js`,
 * 此时不报错,返回空数组,agentRegistry 保持空。
 *
 * dev 按需模式下 `reloadAgents` 也会调用此函数重新水合（`setLoadTimestamp` 已在外层设置）。
 *
 * @returns 水合后的 AgentMetadata[]（供调用方日志/调试）
 */
export async function loadAndHydrateAgents(
  rootDir: string,
  dist: string,
): Promise<AgentMetadata[]> {
  const agentsPath = path.resolve(rootDir, dist, AGENTS_FILE);
  if (!fs.existsSync(agentsPath)) {
    return [];
  }
  const serialized = (await importWithCacheBust(agentsPath)) as unknown as {
    agents: SerializedAgentRecord[];
  };
  const hydrated = hydrateAgents(serialized.agents ?? []);
  hydrateAgentRegistry(hydrated);
  return hydrated;
}

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
function getCurrentApp(): AppBase | null {
  return (globalThis as Record<symbol, AppBase | undefined>)[APP_INSTANCE_KEY] ?? null;
}

/** 设置/清除当前 app 单例（写入 globalThis，跨模块实例共享） */
function setCurrentApp(app: AppBase | null): void {
  if (app === null) {
    delete (globalThis as Record<symbol, AppBase | undefined>)[APP_INSTANCE_KEY];
  } else {
    (globalThis as Record<symbol, AppBase | undefined>)[APP_INSTANCE_KEY] = app;
  }
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
  'trustedProxy',
  'response',
]);

function isFaapiConfigKey(key: string): boolean {
  return FAAPI_CONFIG_KEYS.has(key);
}

export interface CreateAppOptions {
  /** 项目根目录，默认 process.cwd() */
  rootDir?: string;
  /** 产物输出目录（如 dist 或 .faapi），覆盖环境变量 FAAPI_DIST，默认 'dist' */
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
   * 构建一个模拟请求直接走完整请求链路（CORS / helmet / logger / 全局中间件 / 路由匹配 /
   * schema 校验 / 目录中间件 / handler），不绑定端口，返回已解析的 `{ status, headers, body }`。
   *
   * `listen()` 前后均可调用——`listen()` 后调用常用于 Next.js Server Component 等同进程场景
   * （配合 `getApp()` 拿到 app 实例）。
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
 * - `faapi dev` 启动时固定设为 `.faapi` → 读 dev 产物
 * - `node <dist>/main` 不设 → 默认 `dist`，读 prod 产物
 *
 * 不负责编译 TypeScript——编译由 `faapi dev`（esbuild → `.faapi/`）和 `faapi build`（→ `dist/`）负责。
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

  // 水合 tool 清单（可选产物——无 tool 的项目跳过，toolRegistry 保持空）
  const tools = await loadAndHydrateTools(rootDir, dist);

  // 水合 agent 清单（可选产物——无 agent 的项目跳过，agentRegistry 保持空）
  const agents = await loadAndHydrateAgents(rootDir, dist);

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
    trustedProxy: config?.trustedProxy,
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
          if (tools.length > 0) {
            console.log(`- Loaded ${tools.length} tool(s):`);
            for (const tool of tools) {
              console.log(`  ${tool.name}  ${tool.filePath}`);
            }
          }
          if (agents.length > 0) {
            console.log(`- Loaded ${agents.length} agent(s):`);
            for (const agent of agents) {
              const exports = agent.hasRun ? 'run' : '-';
              console.log(`  ${agent.name} [${exports}]  ${agent.filePath}`);
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
        // mockRes 需为 Writable Stream（PassThrough）以支持 sendNodeResponse 的 pipe 路径
        // （handler 返回值被自动包裹后产生 JSON body，走 nodeStream.pipe(res)）
        const chunks: Buffer[] = [];
        const mockRes = new PassThrough() as PassThrough & {
          statusCode: number;
          _headers: Record<string, string>;
          setHeader(name: string, value: string): void;
          appendHeader(name: string, value: string): void;
          writeHead(status: number, headers?: Record<string, string>): void;
        };
        mockRes.statusCode = 200;
        mockRes._headers = {};
        mockRes.setHeader = function (name: string, value: string) {
          this._headers[name.toLowerCase()] = value;
        };
        mockRes.appendHeader = function (name: string, value: string) {
          const key = name.toLowerCase();
          const existing = this._headers[key];
          this._headers[key] = existing ? `${existing}, ${value}` : value;
        };
        mockRes.writeHead = function (status: number, headers?: Record<string, string>) {
          this.statusCode = status;
          if (headers) {
            Object.assign(this._headers, headers);
          }
        };

        mockRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        mockRes.on('error', reject);
        mockRes.on('finish', () => {
          const body = Buffer.concat(chunks);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString());
          } catch {
            parsed = body.toString();
          }
          resolve({
            status: mockRes.statusCode,
            headers: new Headers(mockRes._headers as Record<string, string>),
            body: parsed,
          });
        });

        const listeners = server.listeners('request');
        const handler = listeners[listeners.length - 1];
        if (typeof handler !== 'function') {
          reject(new Error('No request handler found'));
          return;
        }

        const mockReq: Readable & {
          method?: string;
          url?: string;
          headers?: Record<string, string | undefined>;
          socket?: { remoteAddress?: string };
        } = Readable.from(body !== undefined ? [Buffer.from(JSON.stringify(body))] : []);
        mockReq.method = method;
        mockReq.url = `${reqPath}${queryStr}`;
        mockReq.headers = {
          ...reqHeaders,
          host: 'localhost',
          'content-type': body !== undefined ? 'application/json' : undefined,
        };
        mockReq.socket = { remoteAddress: '127.0.0.1' };

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

      // 清理 tool / agent / skill 注册表 + agent handle 工厂（与 app 单例清理对称）
      clearToolRegistry();
      clearAgentRegistry();
      clearSkillRegistry();
      clearAgentHandleFactory();

      // server 未 listen 时直接清理状态（避免 ERR_SERVER_NOT_RUNNING 错误）
      if (!server.listening) {
        app.server = null;
        // 清理单例（仅当单例仍指向当前 app 时，避免被后续 app 误清）
        if (getCurrentApp() === app) setCurrentApp(null);
        return;
      }

      return new Promise<void>((resolve) => {
        server.close((err) => {
          if (err) console.error('Error closing server:', err);
          app.server = null;
          // 清理单例（仅当单例仍指向当前 app 时，避免被后续 app 误清）
          if (getCurrentApp() === app) setCurrentApp(null);
          resolve();
        });
      });
    },
  };

  // 设置单例（覆盖之前的实例；测试场景下多次创建会覆盖，close 时只清自己）
  // 通过 globalThis 存储，确保 Next.js Turbopack dev server runtime 加载的模块实例也能读到
  setCurrentApp(app);

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
