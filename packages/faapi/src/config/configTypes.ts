import type { FaapiContext } from '../runtime/contextTypes';
import type { FaapiMiddleware } from '../middleware/middlewareTypes';
import type { InjectorMap } from '../middleware/injectorTypes';
import type { PluginDeclaration } from './pluginTypes';

/**
 * 统一响应格式化函数
 *
 * 当配置了 responseFormat 时，handler 返回的非 Response 值会经过此函数包装
 * 例如：{ code: 0, data, message: 'success' }
 */
export type ResponseFormatFn = (data: unknown, ctx: FaapiContext) => unknown;

/**
 * 错误响应格式化函数
 *
 * 优先于内置 formatErrorResponse 处理错误。返回 Response 表示已处理；
 * 返回 null/undefined 表示不处理，由内置 formatErrorResponse 兜底。
 */
export type ErrorFormatFn = (error: unknown, ctx?: FaapiContext) => Response | null | undefined;

/**
 * 生命周期钩子
 */
export interface LifecycleHooks {
  /** 路由加载完成、服务器启动前调用（适合初始化数据库连接等） */
  onReady?: (ctx: LifecycleContext) => Promise<void> | void;
  /** 服务器关闭时调用（适合清理资源、优雅关闭） */
  onClose?: (ctx: LifecycleContext) => Promise<void> | void;
  /**
   * 请求错误已被 errorFormat 处理为响应后调用（参考 Fastify onError 语义）
   *
   * 时机：handler 抛错 → errorFormat 生成错误响应（失败则由框架内置 formatErrorResponse 兜底）
   *      → 响应发出后 → onError 触发副作用
   *
   * 职责：日志上报、告警、链路追踪等副作用。**不修改、不替换已生成的响应**。
   * 自身抛错会被捕获并忽略，不影响响应已发送的事实。
   *
   * 与 errorFormat 的区别：
   * - errorFormat：把 error 翻译成 Response（主入口，决定响应内容）
   * - onError：响应发出后的副作用（不能改响应）
   */
  onError?: (error: unknown, ctx: FaapiContext) => Promise<void> | void;
}

/**
 * 生命周期上下文
 */
export interface LifecycleContext {
  /** 项目根目录 */
  rootDir: string;
  /** 当前路由清单 */
  routes: import('../router/routeTypes.js').RouteManifest;
  /** 服务器实例 */
  server: import('node:http').Server;
}

/**
 * faapi 配置文件类型
 *
 * 在项目根目录创建 faapi.config.ts：
 * ```ts
 * import type { FaapiConfig } from '@faapi/faapi';
 * export default {
 *   port: 3000,
 *   cors: { origin: '*' },
 * } satisfies FaapiConfig;
 * ```
 *
 * 多环境配置：
 * ```ts
 * import type { FaapiConfig } from '@faapi/faapi';
 * export default {
 *   port: 3000,
 *   cors: { origin: '*' },
 *   // 自定义业务配置（任意 key）
 *   db: { host: 'localhost', port: 5432 },
 * } satisfies FaapiConfig;
 * ```
 *
 * 环境覆盖通过 faapi.config.{NODE_ENV}.ts 实现（如 faapi.config.production.ts）
 */
export interface FaapiConfig {
  /** 服务端口，默认 3000（可被 --port / PORT 环境变量覆盖） */
  port?: number;
  /** 静态文件目录 */
  staticDir?: string;
  /** CORS 配置，false 禁用 */
  cors?: import('../middleware/cors.js').CorsOptions | boolean;
  /** 统一响应格式化函数 */
  responseFormat?: ResponseFormatFn;
  /** 错误响应格式化函数 */
  errorFormat?: ErrorFormatFn;
  /** 生命周期钩子 */
  lifecycle?: LifecycleHooks;

  /**
   * 全局中间件：对所有路由（HTTP + WebSocket 握手）生效
   *
   * 执行顺序：全局中间件在最外层，目录中间件在内层，handler 最内层。
   * 全局中间件拦截（返回 Response）则目录中间件和 handler 不执行。
   * 全局中间件塞入 ctx 的值，目录中间件和 handler 可读取。
   *
   * 与 CORS 的关系：CORS 由 `cors` 字段配置，全局中间件在 CORS 之后执行。
   *
   * ```ts
   * import type { FaapiConfig, FaapiMiddleware } from '@faapi/faapi';
   *
   * const requestId: FaapiMiddleware = async (ctx, next) => {
   *   ctx.requestId = crypto.randomUUID();
   *   await next();
   * };
   *
   * export default {
   *   middlewares: [requestId],
   * } satisfies FaapiConfig;
   * ```
   *
   * 详见 `src/middleware/README.md` 全局中间件章节。
   */
  middlewares?: FaapiMiddleware[];

  /**
   * 全局注入器：对所有路由的 handler 参数注入生效
   *
   * 合并规则：`{ ...全局注入器, ...目录注入器 }`，目录注入器覆盖全局同名。
   * 全局注入器独立于中间件链，仅提供依赖（db、redis 等），不参与请求流程。
   *
   * ```ts
   * import type { FaapiConfig, InjectorMap } from '@faapi/faapi';
   *
   * export default {
   *   injectors: {
   *     db: () => getDbConnection(),
   *     redis: () => getRedis(),
   *   },
   * } satisfies FaapiConfig;
   * ```
   *
   * 详见 `src/middleware/README.md` 全局注入器章节。
   */
  injectors?: InjectorMap;

  /**
   * 插件：应用级扩展，在 server 启动后、onReady 之前按声明顺序加载
   *
   * 与中间件的区别：中间件拦截每个请求，插件在启动时初始化（如启动后台服务、注册协议等）
   *
   * ```ts
   * import type { FaapiConfig } from '@faapi/faapi';
   * export default {
   *   plugins: [
   *     '@faapi/schema',                          // 包名
   *     ['@faapi/schema', { stdio: true }],        // 带选项
   *     { package: '@faapi/schema', enable: true }, // 完整声明
   *     { path: './my-plugin' },                    // 本地路径
   *   ],
   * } satisfies FaapiConfig;
   * ```
   */
  plugins?: PluginDeclaration[];

  /**
   * 扩展 ctx：在每次请求创建上下文后调用，可挂载自定义方法（如 ctx.xml、ctx.stream）
   *
   * 类型增强：用户通过 `declare module '@faapi/faapi'` 扩展 FaapiContext 接口获得类型提示
   *
   * ```ts
   * // faapi.config.ts
   * declare module '@faapi/faapi' {
   *   interface FaapiContext {
   *     xml(data: string): Response;
   *   }
   * }
   * export default {
   *   extendContext(ctx) {
   *     ctx.xml = (data) => new Response(data, { headers: { 'Content-Type': 'application/xml' } });
   *   },
   * } satisfies FaapiConfig;
   * ```
   */
  extendContext?: (ctx: FaapiContext) => void;

  /**
   * 自定义业务配置（任意 key）
   *
   * 用户可以在这里放数据库连接、Redis 配置等
   * 通过 ctx.config 访问
   *
   * ```ts
   * export default {
   *   db: { host: 'localhost', port: 5432 },
   *   redis: { host: '127.0.0.1', port: 6379 },
   * } satisfies FaapiConfig;
   * ```
   */
  [key: string]: unknown;
}
