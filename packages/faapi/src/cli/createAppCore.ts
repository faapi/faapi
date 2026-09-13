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
import { hydrateTasks, TASKS_FILE } from './generateTaskArtifacts';
import { createTaskQueue } from '../task/taskQueue';
import { loadTaskDriver } from '../task/loadTaskDriver';
import { createCronScheduler, type CronScheduler } from '../task/cronScheduler';
import type { TaskClient, TaskQueue } from '../task/taskTypes';
import { loadPlugins } from './loadPlugins';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import {
  createAppRegistries,
  defaultRegistries,
  type AppRegistries,
} from '../injection/registries';
import type { ToolMetadata } from '../ast/extractToolMetadata';
import type { AgentMetadata } from '../ast/extractAgentMetadata';
import type { FaapiConfig } from '../config/configTypes';
import { ROUTE_PATTERNS } from '../utils/prodPaths';

export interface InjectOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  /**
   * 请求体，语义按类型区分（与 fastify inject 约定一致）：
   * - `string` / `Buffer` / `Uint8Array`：原样透传不二次编码（默认 content-type
   *   分别为 `text/plain` / `application/octet-stream`）
   * - 其他值（对象/数组等）：`JSON.stringify` 后发送，默认 content-type `application/json`
   *
   * 调用方显式传入的 `content-type` 头优先于默认值（string body +
   * `application/x-www-form-urlencoded` 可直接测 form 表单路由）。
   * 注意不要把 `JSON.stringify` 的结果当对象传——那会作为原始文本再被服务端
   * JSON 解析一次，得到字符串而非对象。
   */
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
export async function loadAndHydrateTools(
  rootDir: string,
  dist: string,
  registries: AppRegistries = defaultRegistries,
): Promise<ToolMetadata[]> {
  const toolsPath = path.resolve(rootDir, dist, TOOLS_FILE);
  if (!fs.existsSync(toolsPath)) {
    return [];
  }
  const serialized = (await importWithCacheBust(toolsPath)) as unknown as {
    tools: SerializedToolRecord[];
  };
  const hydrated = hydrateTools(serialized.tools ?? []);
  registries.tool.hydrate(hydrated);
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
  registries: AppRegistries = defaultRegistries,
): Promise<AgentMetadata[]> {
  const agentsPath = path.resolve(rootDir, dist, AGENTS_FILE);
  if (!fs.existsSync(agentsPath)) {
    return [];
  }
  const serialized = (await importWithCacheBust(agentsPath)) as unknown as {
    agents: SerializedAgentRecord[];
  };
  const hydrated = hydrateAgents(serialized.agents ?? []);
  registries.agent.hydrate(hydrated);
  return hydrated;
}

/**
 * 读取 config.task 中的驱动选项（pgboss/bullmq 的连接配置透传给驱动工厂）
 */
function getTaskDriverOptions(config: FaapiConfig | null): unknown {
  if (!config?.task) return undefined;
  const taskConfig = config.task as Record<string, unknown>;
  const driver = taskConfig.driver;
  if (driver === 'pgboss') return taskConfig.pgboss;
  if (driver === 'bullmq') return taskConfig.bullmq;
  return undefined;
}

/**
 * 加载 faapi-tasks.js 并水合到 taskRegistry（app 实例）
 *
 * 与 `loadAndHydrateTools` 对称——任务是可选能力，无任务的项目清单为空数组，
 * taskRegistry 保持空，任务队列空转。
 *
 * @returns 水合后的 TaskMetadata[]（供调用方日志/调试）
 */
export async function loadAndHydrateTasks(
  rootDir: string,
  dist: string,
  registries: AppRegistries = defaultRegistries,
): Promise<ReturnType<typeof hydrateTasks>> {
  const tasksPath = path.resolve(rootDir, dist, TASKS_FILE);
  if (!fs.existsSync(tasksPath)) {
    return [];
  }
  const serialized = (await importWithCacheBust(tasksPath)) as unknown as {
    tasks: Parameters<typeof hydrateTasks>[0];
  };
  const hydrated = hydrateTasks(serialized.tasks ?? []);
  registries.task.hydrate(hydrated);
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

/** 默认优雅关闭信号 handler 是否已安装（写入 globalThis，跨模块实例共享） */
const SHUTDOWN_INSTALLED_KEY = Symbol.for('faapi.defaultShutdownInstalled');

/**
 * 注册默认优雅关闭信号（SIGTERM/SIGINT，进程级仅注册一次）
 *
 * 收到信号时关闭当前 app 单例（app.close() 内部完成 drain + onClose 钩子 +
 * 注册表清理）后退出。faapi 单进程单 app 设计——单例即唯一运行中的 app；
 * 测试场景多次 listen 不会堆积 process 监听器（globalThis 标记防重装）。
 */
function registerDefaultShutdownHandlers(): void {
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

/** FaapiConfig 的内置 key 集合（排除自定义业务配置） */
const FAAPI_CONFIG_KEYS = new Set([
  'cors',
  'lifecycle',
  'middlewares',
  'injectors',
  'extendContext',
  'plugins',
  'helmet',
  'compression',
  'etag',
  'bodyLimit',
  'logger',
  'http2',
  'trustedProxy',
  'response',
  'task',
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
  /** app 级注册表（tool/agent/skill/agentHandle 实例，close 时清理） */
  registries: AppRegistries;
  /** 排序后的路由清单 */
  routes: RouteManifest;
  /** WebSocket 路由清单 */
  wsRoutes: WsRouteManifest;
  /** 项目根目录 */
  rootDir: string;
  /** 任务队列客户端（入队/查询；app 实例级，close 时随队列停机） */
  tasks: TaskClient;
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
  /** app 级注册表（tool/agent/skill/agentHandle 实例，随 app 生命周期） */
  registries: AppRegistries;
  /** 产物目录 */
  dist: string;
  /** 扫描 patterns（scanRoutes 用） */
  patterns: string[];
  /** 任务队列实例（reloadTasks 清模块/schema 缓存用） */
  taskQueue: TaskQueue;
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

  // app 级注册表（方案 A 实例化）：每个 app 持有独立实例，随 app 创建/销毁，
  // 多 app 同进程互不串台。框架链路（请求注入 / 插件 / lifecycle）只读写此实例
  const registries = createAppRegistries();

  // 水合 tool 清单（可选产物——无 tool 的项目跳过，tool 注册表保持空）
  const tools = await loadAndHydrateTools(rootDir, dist, registries);

  // 水合 agent 清单（可选产物——无 agent 的项目跳过，agent 注册表保持空）
  const agents = await loadAndHydrateAgents(rootDir, dist, registries);

  // 水合任务清单 + 创建任务队列与 cron 调度器（app 实例级，close 时一并停机）
  // 队列不依赖 HTTP listen——createAppBase 即启动（enabled 时），onBoot 校验失败
  // 的 listen 路径负责停机
  const taskMetas = await loadAndHydrateTasks(rootDir, dist, registries);
  const taskDriver = await loadTaskDriver(config?.task?.driver, getTaskDriverOptions(config));
  const taskQueue = createTaskQueue({
    registry: registries.task,
    rootDir,
    config,
    driver: taskDriver,
  });
  const cronScheduler: CronScheduler = createCronScheduler(registries.task, (name) =>
    taskQueue.enqueue(name),
  );
  const taskEnabled =
    process.env.FAAPI_TASKS_DISABLED === '1' ? false : (config?.task?.enabled ?? true);
  const stopTaskRuntime = async (): Promise<void> => {
    cronScheduler.stop();
    await taskQueue.stop(config?.task?.shutdownTimeoutMs ?? 10_000);
  };
  if (taskEnabled) {
    taskQueue.start();
    cronScheduler.start();
  }
  registries.taskHandle.register(() => taskQueue);

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
    compression: config?.compression,
    etag: config?.etag,
    logger: config?.logger,
    bodyLimit: config?.bodyLimit,
    http2: config?.http2,
    trustedProxy: config?.trustedProxy,
    registries,
  });

  // 加载插件 + 应用 handler/upgrade 包装器（dist 供本地 TS 插件按需编译/产物复用）
  const { handlerWrappers, upgradeWrappers } = await loadPlugins(
    config?.plugins,
    {
      rootDir,
      registries,
      routes: sorted,
      getRoutes: () => sorted,
      server,
      config: pluginConfig,
    },
    rootDir,
    dist,
  );
  applyPluginWrappers(server, handlerWrappers, upgradeWrappers);

  // 关闭状态标记（避免重复关闭）
  let closed = false;

  const app: AppBase = {
    server: null,
    registries,
    routes: sorted,
    wsRoutes,
    rootDir,
    tasks: taskQueue,

    async listen(listenPort?: number): Promise<Server> {
      // 端口优先级：listen() 参数 > options.port > 环境变量 PORT > 默认 3000
      const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
      const actualPort = listenPort ?? options?.port ?? envPort ?? DEFAULT_PORT;

      // onBoot 生命周期钩子（listen 前）：启动校验 / DB 迁移等"失败即不该暴露端口"的逻辑。
      // 此时 server 已创建但未监听、路由/tool/agent 清单已水合、插件已加载。
      // 抛错 → listen() 以原始错误 reject，server.listen 不会被调用，端口不暴露。
      if (config?.lifecycle?.onBoot) {
        try {
          await config.lifecycle.onBoot({
            rootDir,
            routes: sorted,
            server,
            registries,
            tasks: taskQueue,
          });
          console.log('- onBoot hook executed');
        } catch (err) {
          // 启动校验失败：端口不暴露，同时停掉已启动的任务运行时（cron + worker）
          await stopTaskRuntime();
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[faapi] onBoot hook failed: ${message}`);
          throw err;
        }
      }

      return new Promise<Server>((resolve, reject) => {
        // listen 阶段错误（端口占用等）转为 Promise reject，避免未监听 'error'
        // 事件以裸堆栈崩掉进程；成功后解除，运行期错误语义不变
        const onListenError = (err: Error): void => {
          if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
            reject(
              new Error(
                `Port ${actualPort} is already in use. ` +
                  `Is another faapi instance running? Change the port via the PORT env var.`,
              ),
            );
            return;
          }
          reject(err);
        };
        server.once('error', onListenError);
        server.listen(actualPort, async () => {
          server.off('error', onListenError);
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
          if (taskMetas.length > 0) {
            console.log(`- Loaded ${taskMetas.length} task(s):`);
            for (const taskMeta of taskMetas) {
              const schedule = taskMeta.cron ? ` cron=${taskMeta.cron}` : '';
              console.log(`  ${taskMeta.name}${schedule}  ${taskMeta.filePath}`);
            }
          }

          // 注册默认优雅关闭信号（进程级仅注册一次，faapi 单进程单 app 设计）
          registerDefaultShutdownHandlers();

          // onReady 生命周期钩子
          if (config?.lifecycle?.onReady) {
            await config.lifecycle.onReady({
              rootDir,
              routes: sorted,
              server,
              registries,
              tasks: taskQueue,
            });
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

        // body 按类型区分语义（与 fastify inject 一致）：string/Uint8Array 原样透传
        // 不二次编码，其他值 JSON.stringify；调用方显式 content-type 优先于默认值
        let payload: Buffer | undefined;
        let defaultContentType: string | undefined;
        if (body !== undefined) {
          if (typeof body === 'string') {
            payload = Buffer.from(body, 'utf-8');
            defaultContentType = 'text/plain';
          } else if (body instanceof Uint8Array) {
            payload = Buffer.from(body);
            defaultContentType = 'application/octet-stream';
          } else {
            payload = Buffer.from(JSON.stringify(body));
            defaultContentType = 'application/json';
          }
        }

        const mockReq: Readable & {
          method?: string;
          url?: string;
          headers?: Record<string, string | undefined>;
          socket?: { remoteAddress?: string };
        } = Readable.from(payload !== undefined ? [payload] : []);
        mockReq.method = method;
        mockReq.url = `${reqPath}${queryStr}`;
        const hasCallerContentType = 'content-type' in reqHeaders || 'Content-Type' in reqHeaders;
        mockReq.headers = {
          ...reqHeaders,
          host: 'localhost',
          ...(payload !== undefined && !hasCallerContentType
            ? { 'content-type': defaultContentType }
            : {}),
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

      const s = server as unknown as {
        closeIdleConnections?: () => void;
        closeAllConnections?: () => void;
      };

      // 停止接受新连接 + 断开空闲 keep-alive 连接；在途请求继续执行直至完成（drain）。
      // 此前 closeAllConnections 在等待之前调用，会直接掐断在途请求（硬关，非优雅停机）
      s.closeIdleConnections?.();

      // 任务队列 drain：停止出队 + 停 cron，等在跑任务结束（超时 abort），再执行
      // onClose——保证业务方清理资源（DB 等）时没有任务还在执行
      await stopTaskRuntime();

      if (config?.lifecycle?.onClose) {
        await config.lifecycle.onClose({
          rootDir,
          routes: sorted,
          server,
          registries,
          tasks: taskQueue,
        });
      }

      // 注册表（方案 A 实例化）：清理的是 app 自己的实例——多 app 同进程
      // 天然隔离，无需所有权守卫；全局默认实例不被 app 生命周期触碰
      registries.tool.clear();
      registries.agent.clear();
      registries.skill.clear();
      registries.task.clear();
      registries.agentHandle.clear();
      registries.taskHandle.clear();

      // server 未 listen 时直接清理状态（避免 ERR_SERVER_NOT_RUNNING 错误）
      if (!server.listening) {
        app.server = null;
        // 清理单例（仅当单例仍指向当前 app 时，避免被后续 app 误清）
        if (getCurrentApp() === app) setCurrentApp(null);
        return;
      }

      const drained = new Promise<void>((resolve) => {
        server.close((err) => {
          if (err) console.error('Error closing server:', err);
          resolve();
        });
      });

      // drain：等在途请求完成。SSE/WS 长连接永不主动结束，超时后强制断开
      // （默认 10s，FAAPI_SHUTDOWN_TIMEOUT_MS 环境变量可调）
      const drainTimeoutMs = Number(process.env.FAAPI_SHUTDOWN_TIMEOUT_MS ?? 10_000);
      if (
        typeof s.closeAllConnections === 'function' &&
        Number.isFinite(drainTimeoutMs) &&
        drainTimeoutMs >= 0
      ) {
        const forceClose = new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            s.closeAllConnections?.();
            resolve();
          }, drainTimeoutMs);
          // 停机定时器不应阻止进程自然退出
          timer.unref?.();
        });
        await Promise.race([drained, forceClose]);
        // 强制断开后 close 回调随即触发；短兜底等待收尾完成
        const tail = new Promise<void>((resolve) => setTimeout(resolve, 250).unref?.());
        await Promise.race([drained, tail]);
      } else {
        await drained;
      }

      app.server = null;
      // 清理单例（仅当单例仍指向当前 app 时，避免被后续 app 误清）
      if (getCurrentApp() === app) setCurrentApp(null);
    },
  };

  // 设置单例（覆盖之前的实例；测试场景下多次创建会覆盖，close 时只清自己）
  // 通过 globalThis 存储，确保 Next.js Turbopack dev server runtime 加载的模块实例也能读到
  setCurrentApp(app);

  /** 更新路由引用（app + routesRef + 闭包变量） */
  const ctx: AppContext = {
    rootDir,
    registries,
    dist,
    patterns: ROUTE_PATTERNS,
    taskQueue,
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
