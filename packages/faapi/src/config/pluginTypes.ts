import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Socket } from 'node:net';
import type { RouteManifest } from '../router/routeTypes';

/** HTTP 请求 handler 类型 */
export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;
/** WebSocket 升级 handler 类型 */
export type UpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer) => void;

/**
 * 插件上下文：插件 setup 函数接收的框架能力
 *
 * 插件通过 ctx 访问路由、服务器实例等，不需要直接依赖框架内部模块。
 *
 * 插件可通过 `wrapHandler` / `wrapUpgradeHandler` 在 server.listen 之前包装请求处理逻辑，
 * 用于集成其他框架（如 Next.js）：`/api/*` 走 faapi，其余走被集成框架。
 */
export interface PluginContext {
  /** 项目根目录 */
  rootDir: string;
  /** 当前路由清单（setup 时的快照，reloadRoutes 后不会更新；需最新路由用 getRoutes()） */
  routes: RouteManifest;
  /** 获取最新路由清单（reloadRoutes 后返回更新后的数组） */
  getRoutes: () => RouteManifest;
  /** HTTP 服务器实例（未 listen） */
  server: Server;
  /** 自定义业务配置（faapi.config.ts 中的自定义 key） */
  config: Record<string, unknown>;
  /** 插件选项（来自声明中的 options 字段或元组第二个元素） */
  options?: unknown;
  /**
   * 注册 HTTP handler 包装函数（在 server.listen 之前应用，按注册顺序嵌套）
   *
   * 包装函数接收原始 handler，返回新的 handler。多个包装器按注册顺序嵌套：
   * finalHandler = wrap1(wrap2(originalHandler))
   *
   * 典型场景：集成 Next.js，`/api/*` 走 faapi，其余走 Next.js getRequestHandler。
   */
  wrapHandler?: (fn: (original: RequestHandler) => RequestHandler) => void;
  /**
   * 注册 WS upgrade handler 包装函数（在 server.listen 之前应用，按注册顺序嵌套）
   *
   * 包装函数接收原始 upgrade handler（可能为 undefined，表示 faapi 无 WS 路由），
   * 返回新的 upgrade handler。多个包装器按注册顺序嵌套。
   *
   * 典型场景：faapi WS 路由走 original，其余走 Next.js HMR。
   */
  wrapUpgradeHandler?: (fn: (original: UpgradeHandler | undefined) => UpgradeHandler) => void;
}

/**
 * faapi 插件接口
 *
 * 插件是一个对象，包含 name 和 setup 函数。
 * 框架在 server 创建后、listen 之前按声明顺序加载插件，调用 setup(ctx)。
 *
 * 插件可通过 ctx.wrapHandler / ctx.wrapUpgradeHandler 包装请求处理逻辑，
 * 用于集成其他框架（如 Next.js）。
 *
 * ```ts
 * import type { FaapiPlugin, PluginContext } from '@faapi/faapi';
 *
 * export default {
 *   name: 'my-plugin',
 *   setup(ctx: PluginContext) {
 *     console.log(`Plugin loaded, ${ctx.routes.length} routes found`);
 *   },
 * } satisfies FaapiPlugin;
 * ```
 */
export interface FaapiPlugin {
  /** 插件名称（用于去重和日志） */
  name: string;
  /** 插件初始化函数，在 server 创建后、listen 之前调用 */
  setup: (ctx: PluginContext) => Promise<void> | void;
}

/**
 * 插件声明：用户在 faapi.config.ts 的 plugins 字段中使用
 *
 * 支持三种形式：
 * - 包名字符串：`'@faapi/schema'`
 * - 带选项的元组：`['@faapi/schema', { stdio: true }]`
 * - 完整声明对象：`{ package: '@faapi/schema', enable: true }`
 * - 本地路径：`{ path: './my-plugin' }`
 */
export type PluginDeclaration =
  | string
  | [string, unknown]
  | { package: string; enable?: boolean; options?: unknown }
  | { path: string; enable?: boolean; options?: unknown };
