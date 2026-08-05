import type { FaapiContext } from '../runtime/contextTypes';
import type { FaapiMiddleware } from '../middleware/middlewareTypes';
import type { InjectorMap } from '../middleware/injectorTypes';
import type { PluginDeclaration } from './pluginTypes';
import type { HelmetOptions } from '../middleware/helmet';
import type { LoggerOptions } from '../middleware/logger';
import type { Http2Options } from '../server/createServer';

/**
 * 生命周期钩子
 */
export interface LifecycleHooks {
  /** 服务器启动后调用（适合初始化数据库连接等） */
  onReady?: (ctx: LifecycleContext) => Promise<void> | void;
  /** 服务器关闭时调用（适合清理资源、优雅关闭） */
  onClose?: (ctx: LifecycleContext) => Promise<void> | void;
  /**
   * 请求错误已被处理为响应后调用(参考 Fastify onError 语义)
   *
   * 时机:handler 抛错 → 全局中间件 try/catch(若有) → 框架内置 formatErrorResponse 兜底
   *      → 响应发出后 → onError 触发副作用
   *
   * 职责:日志上报、告警、链路追踪等副作用。**不修改、不替换已生成的响应**。
   * 自身抛错会被捕获并忽略,不影响响应已发送的事实。
   *
   * 与全局错误中间件的区别:
   * - 全局错误中间件:把 error 翻译成 Response(主入口,决定响应内容)
   * - onError:响应发出后的副作用(不能改响应)
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
 * 统一响应包装配置
 *
 * 配置后,框架自动:
 * - 成功响应:handler return 非 Response 的值时,用 ok 函数包裹
 * - 错误响应:ctx.fail() 用 fail 函数包装 body
 *
 * 未配置 response 时,使用框架默认实现:
 * - ok: (data) => ({ data })
 * - fail: ({ status, code, message }) => 省略的字段不放入 error 对象
 *
 * ```ts
 * import type { FaapiConfig } from '@faapi/faapi';
 * export default {
 *   response: {
 *     // 自定义成功包装(默认 { data })
 *     ok: (data) => ({ code: 0, data }),
 *     // 自定义错误包装(默认 { error: { message, ...code?, ...status? } })
 *     fail: ({ status, code, message }) => ({ error: { code, message } }),
 *   },
 * } satisfies FaapiConfig;
 * ```
 */
export interface ResponseConfig {
  /**
   * 成功响应包装函数
   *
   * handler return 非 Response 的值时调用。
   * 默认: (data) => ({ data })
   */
  ok?: (data: unknown) => unknown;

  /**
   * 错误响应包装函数
   *
   * ctx.fail() 调用时使用,接收 { status?, code?, message }。
   * status 和 code 均可能为 undefined(用户调用 ctx.fail 时省略则不传),
   * 默认实现只把非 undefined 的字段放入 error 对象。
   */
  fail?: (error: { status?: number; code?: string; message: string }) => unknown;
}

/**
 * faapi 配置文件类型
 *
 * 在项目根目录创建 faapi.config.ts：
 * ```ts
 * import type { FaapiConfig } from '@faapi/faapi';
 * export default {
 *   cors: { origin: '*' },
 * } satisfies FaapiConfig;
 * ```
 *
 * 自定义业务配置（任意 key）：
 * ```ts
 * import type { FaapiConfig } from '@faapi/faapi';
 * export default {
 *   cors: { origin: '*' },
 *   // 通过 process.env.XXX 读取 .env 文件加载的环境变量
 *   db: { host: process.env.DB_HOST ?? 'localhost', port: 5432 },
 * } satisfies FaapiConfig;
 * ```
 *
 * 多环境差异通过 `.env` 系列文件实现（见 `loadEnv`）：
 * - `.env` / `.env.local` / `.env.{env}` / `.env.{env}.local`
 * - 环境由 `NODE_ENV > 'development'` 决定
 *
 * 框架元信息通过环境变量配置（不放在 config 内）：
 * - `PORT`：服务端口，默认 3000
 * - `FAAPI_DIST`：产物输出目录，dev 固定为 `.faapi`（不可修改），prod 默认为 `dist`（可通过 `--dist` 修改）
 */
export interface FaapiConfig {
  /** CORS 配置，false 禁用 */
  cors?: import('../middleware/cors.js').CorsOptions | boolean;
  /** 生命周期钩子 */
  lifecycle?: LifecycleHooks;

  /** 安全头配置，false 禁用 */
  helmet?: HelmetOptions | boolean;
  /** 请求体大小限制（字节），默认 10MB（10 * 1024 * 1024） */
  bodyLimit?: number;
  /** 日志中间件配置 */
  logger?: LoggerOptions | boolean;
  /** HTTP/2 配置，false 禁用（默认 http/1.1） */
  http2?: Http2Options | boolean;

  /**
   * 统一响应包装配置
   *
   * 配置后,框架自动包裹 handler 返回值:
   * - 成功响应:handler return 非 Response → 用 ok 函数包裹(默认 `{ data }`)
   * - 错误响应:ctx.fail() 用 fail 函数包装(默认 `{ error: { message, ...code? } }`)
   *
   * 未配置 response 时,使用框架默认实现(见 ResponseConfig)。
   * 配置 response 后,ok/fail 各字段均可选,按需覆盖。
   *
   * ```ts
   * import type { FaapiConfig } from '@faapi/faapi';
   * export default {
   *   response: {
   *     ok: (data) => ({ code: 0, data }),
   *     fail: ({ status, code, message }) => ({ error: { code, message } }),
   *   },
   * } satisfies FaapiConfig;
   * ```
   *
   * 详见 `src/config/configTypes.md` 统一响应包装章节。
   */
  response?: ResponseConfig;

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
