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
 * model 级配置（Phase 3.5）
 *
 * 挂在 provider 下的单个 model 配置，model 特定字段透传给 LLM API
 * （覆盖 provider 级同名字段）。空对象 `{}` 表示用 provider 级默认。
 *
 * ```ts
 * models: {
 *   'gpt-4o': {},                            // 用 provider 级默认
 *   'gpt-4o-mini': { temperature: 0.5 },     // 覆盖 temperature
 * }
 * ```
 */
export interface LlmModelConfig {
  [key: string]: unknown;
}

/**
 * LLM provider 配置（Phase 2.4，Phase 3.5 改为嵌套级联结构）
 *
 * 嵌套级联：provider 在外层，model 在 `models` 下挂多个。
 * provider 级字段（`apiKey` / `baseURL`）共享给所有 model；
 * model 级字段在 `models[modelName]` 里覆盖 provider 级同名字段。
 *
 * `config.agent.llms` 的 key 是 provider 名（如 `'openai'` / `'anthropic'`），
 * `config.agent.defaultLlm` 指定默认 provider key（不传时用 `llms` 第一个 key）。
 *
 * 由 Phase 3.2 的 `@faapi/agent` 插件读取，调 `createProvider` 创建实例存 Map。
 *
 * ```ts
 * llms: {
 *   openai: {
 *     provider: 'openai',
 *     apiKey: process.env.OPENAI_API_KEY,
 *     baseURL: 'https://api.openai.com/v1',
 *     models: { 'gpt-4o': {}, 'gpt-4o-mini': { temperature: 0.5 } },
 *   },
 *   anthropic: {
 *     provider: 'anthropic',
 *     apiKey: process.env.ANTHROPIC_API_KEY,
 *     models: { 'claude-3-5-sonnet': {} },
 *   },
 * }
 * ```
 */
export interface LlmConfig {
  /**
   * LLM 提供方标识（如 'openai' / 'anthropic'）
   *
   * Phase 3.2 的 provider 模块按此值选择对应的 LLM 适配器。
   */
  provider: string;
  /**
   * API key（从 `process.env` 读取，避免硬编码）
   *
   * 如 `process.env.OPENAI_API_KEY`。
   */
  apiKey?: string;
  /**
   * API 基础 URL（可选，用于 OpenAI 兼容 API 如 Azure OpenAI / 中转服务）
   *
   * 未设置时用 provider 对应的官方默认值（如 'https://api.openai.com/v1'）。
   */
  baseURL?: string;
  /**
   * 该 provider 下挂的 model 列表（key 是 model 名）
   *
   * handler 通过 `agent.run(input, { model: 'gpt-4o' })` 切换 model,
   * 框架按 model 名在所有 provider 的 `models` 里查找定位 provider（详见
   * [agentHandle](../../agent/src/agentHandle.md) 的 Run-level 覆盖优先级表）。
   * model 级字段（如 `temperature`）覆盖 provider 级同名字段。
   */
  models: Record<string, LlmModelConfig>;
  /**
   * LLM 请求超时（毫秒，可选——未设置时无超时）
   *
   * provider 层用 `AbortSignal.timeout` 实现，与 run-level 的 `signal` 组合生效。
   * 超时触发抛 `LLMProviderError`（message 含 timed out），计入重试（429/5xx/网络错误同策略）。
   */
  timeoutMs?: number;
  /**
   * 429 / 5xx / 网络错误的最大重试次数（默认 2，设 0 关闭重试）
   *
   * 退避策略：优先尊重响应的 `Retry-After` 头（秒，封顶 30s），否则指数退避
   * 500ms * 2^attempt。4xx 其他状态（400/401 等）是确定性错误，不重试。
   * 流式请求仅在「连接建立前」重试，流开始输出后中断不重试。
   */
  maxRetries?: number;
  /**
   * 其他透传参数（provider 级，如 temperature / top_p / max_tokens）
   *
   * 这些字段原样传给 LLM API，由 provider 适配器处理。
   * model 级 `models[modelName]` 的同名字段优先。
   */
  [key: string]: unknown;
}

/**
 * agent 子系统全局配置（Phase 2.4，Phase 3.5 LLM 配置改为嵌套级联）
 *
 * 提供 agent 子系统的全局默认值，所有字段均可选，未设置时用框架默认值。
 * agent 自身 `config.maxTurns` / `config.model` 优先于全局配置。
 *
 * ```ts
 * import type { FaapiConfig } from '@faapi/faapi';
 * export default {
 *   agent: {
 *     llms: {
 *       openai: {
 *         provider: 'openai',
 *         apiKey: process.env.OPENAI_API_KEY,
 *         models: { 'gpt-4o': {}, 'gpt-4o-mini': { temperature: 0.5 } },
 *       },
 *     },
 *     defaultLlm: 'openai',
 *     defaultAgent: 'researcher',
 *     maxTurns: 10,
 *     maxAgentDepth: 3,
 *   },
 * } satisfies FaapiConfig;
 * ```
 *
 * 详见 `src/config/configTypes.md` agent 配置块章节。
 */
export interface AgentConfig {
  /**
   * LLM provider 配置映射（Phase 3.5 改为嵌套级联结构，key 是 provider 名）
   *
   * 值是 [LlmConfig]（含 `models`）。plugin setup 时遍历每个 LlmConfig 调
   * `createProvider` 创建实例存 Map，handler 通过 `agent.run(input, { model })`
   * 切换 provider + model（详见 [agentHandle](../../agent/src/agentHandle.md)）。
   *
   * 未设置时 Phase 3.x 插件无法调用 LLM，agent 的 `run` 函数仍可手动实现。
   */
  llms?: Record<string, LlmConfig>;
  /**
   * 默认 provider key（Phase 3.5）
   *
   * `agent.run` 不传 `options.model` 时用此 key 对应的 provider 实例。
   * 未设置时用 `llms` 的第一个 key（`Object.keys(llms)[0]`）。
   */
  defaultLlm?: string;
  /**
   * 默认 agent 名，用于 `agent` 参数注入（[injectParams](../injection/injectParams.md) Phase 2.3）
   *
   * Phase 2.3 的 `agent` 参数注入暂返回 `undefined`，Phase 3.x 的 @faapi/agent 插件
   * 读取此值从 [agentRegistry](../injection/agentRegistry.md) 查找对应 agent 元数据，
   * 注入 `AgentHandle`（含可调用 `run`）。
   *
   * 可选——未设时 handler 需通过 `agent.run(input, { agent: 'name' })` 显式指定 agent 名，
   * 否则 `agent.run` 抛 `AgentError`。
   */
  defaultAgent?: string;
  /**
   * 默认最大对话轮数（覆盖 agent 自身 `config.maxTurns`，agent 自身配置优先）
   *
   * Phase 3.3 的 reactLoop 使用此值作为递归深度防护。
   */
  maxTurns?: number;
  /**
   * agent 调用 agent 的最大递归深度（防护无限递归，Phase 3.3 reactLoop 使用）
   *
   * 默认值由 Phase 3.x 的 @faapi/agent 插件定义（如 3）。
   */
  maxAgentDepth?: number;
  /**
   * 启用 tracing 的全局默认值（默认 false——opt-in,不开启零开销）
   *
   * 开启时 `agent.run()` / `agent.stream()` 返回的 `result.trace` /
   * `chunk.traceEvent` 填充结构化调用明细（按轮次组织的 LLM 调用、tool 调用、
   * sub-agent 嵌套调用事件,含 timing 与 token 用量）。
   *
   * 三层覆盖优先级：`AgentRunOptions.enableTracing` > agent 自身配置 >
   * 此全局配置 > 默认 `false`。
   *
   * tracing 采集每轮 LLM 消息快照与 tool 明细,有真实内存/CPU 开销——
   * 需要观测的端点显式开启：
   *
   * ```ts
   * import type { FaapiConfig } from '@faapi/faapi';
   * export default {
   *   agent: {
   *     enableTracing: true, // 全局开启;单次调用可用 run(input, { enableTracing: true }) 覆盖
   *     llms: { openai: { provider: 'openai', apiKey: '...', models: { 'gpt-4o': {} } } },
   *   },
   * } satisfies FaapiConfig;
   * ```
   *
   * 详见 `@faapi/agent` 的 [trace](../../agent/src/trace.md) 文档。
   */
  enableTracing?: boolean;
  /**
   * 执行守卫（authHooks，见 @faapi/agent 的 authHooks 文档）
   *
   * 每次 tool / sub-agent 执行前调用（`agent.x` 名称为 sub-agent 递归）。
   * 三种返回：`void` 放行；`{ error }` 拒绝（不执行，error 回传 LLM 调整策略）；
   * `{ args }` 改写后放行（多租户场景强制注入可信值，不信 LLM 传入的标识参数）。
   *
   * 典型用法：中间件解析 `ctx.workspace` 后在此校验/强制改写 `args.workspaceId`。
   */
  /**
   * 发送给 LLM 的历史 token 预算（近似估算，未设置 = 不裁剪）
   *
   * 多轮 tool 循环中对话历史只增不减，大 tool 结果会撑爆模型上下文窗口导致
   * 下一轮 400。超预算时从最旧的轮组开始裁剪（system 与初始 user 保留、
   * tool 配对不拆散），只作用于发给 LLM 的消息副本。详见 @faapi/agent 的
   * reactLoop 文档历史裁剪章节。
   */
  maxHistoryTokens?: number;
  beforeToolCall?: (
    name: string,
    args: Record<string, unknown>,
    ctx: FaapiContext | undefined,
  ) => void | { error: string } | { args: Record<string, unknown> };
  /**
   * 审计钩子（authHooks）：tool / sub-agent 成功返回后调用，返回值忽略。
   * 用于日志/审计/计量；异常路径不调用。
   */
  afterToolCall?: (
    name: string,
    args: Record<string, unknown>,
    result: unknown,
    ctx: FaapiContext | undefined,
  ) => void;
  /**
   * 可见性过滤（authHooks）：LLM 可见 tools 清单组装完成后调用，
   * 返回过滤后的数组（含 agent-as-tool 项）。每次 agent.run / stream 生效——
   * 无权 tool 不进 LLM 视野，比执行时拒绝省一轮 LLM 调用。
   */
  filterTools?: (
    tools: Array<{ name: string; description?: string; input: Record<string, unknown> }>,
    ctx: FaapiContext | undefined,
  ) => Array<{ name: string; description?: string; input: Record<string, unknown> }>;
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
   * 是否信任反向代理头（X-Forwarded-For），默认 false
   *
   * - `true`：`ctx.ip` 取 `x-forwarded-for` 第一个 IP——部署在 nginx/CDN 等受信任
   *   反向代理之后时开启
   * - `false`（默认）：直取 socket 地址。客户端直连时 XFF 可被任意伪造，
   *   安全默认不信任（同时影响 HTTP 与 WS 握手的 `ctx.ip`）
   */
  trustedProxy?: boolean;

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
   * agent 子系统全局配置（Phase 2.4）
   *
   * 提供 agent 子系统的全局默认值：LLM 提供方、默认 agent、
   * 最大对话轮数、agent 调用 agent 的最大递归深度。
   *
   * agent 自身 `config.maxTurns` / `config.model` 优先于全局配置。
   * tool 引用列表只在每个 agent 自身的 `config.tools` 里声明（无全局共享 defaultTools）。
   *
   * ```ts
   * import type { FaapiConfig } from '@faapi/faapi';
   * export default {
   *   agent: {
   *     llms: {
   *       openai: {
   *         provider: 'openai',
   *         apiKey: process.env.OPENAI_API_KEY,
   *         models: { 'gpt-4o': {} },
   *       },
   *     },
   *     defaultLlm: 'openai',
   *     defaultAgent: 'researcher',
   *     maxTurns: 10,
   *     maxAgentDepth: 3,
   *   },
   * } satisfies FaapiConfig;
   * ```
   *
   * 详见 `src/config/configTypes.md` agent 配置块章节。
   */
  agent?: AgentConfig;

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
