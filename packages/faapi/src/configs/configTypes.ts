import type { FaapiContext } from '../runtime/contextTypes';
import type { FaapiMiddleware } from '../middlewares/middlewareTypes';
import type { InjectorMap } from '../middlewares/injectorTypes';
import type { PluginDeclaration } from './pluginTypes';
import type { HelmetOptions } from '../middlewares/helmet';
import type { CompressionOptions } from '../middlewares/compression';
import type { EtagOptions } from '../middlewares/etag';
import type { Http2Options } from '../server/createServer';

/**
 * 生命周期钩子已全量事件化（7.x）——原 onBoot/onReady/onClose/onError 四钩子移除,
 * 由 [appEventBus](../events/appEventBus.md) 的 `app:boot` / `app:ready` / `app:close` /
 * `request:error` 事件承载（订阅写 `src/bootstrap.ts`，经 `getApp().on`）。
 * `LifecycleContext` 保留,作为 `app:*` 事件载荷类型。
 */

/**
 * pg-boss 驱动选项（透传给 @faapi/task-pgboss）
 *
 * 主包不依赖 pg-boss，这里只声明常用连接字段的透传形状；完整项见 pg-boss 文档
 * （ConstructorOptions）。
 */
export interface TaskPgBossOptions {
  /** PostgreSQL 连接串（如 `postgres://localhost:5432/app`） */
  connectionString?: string;
  /** 其余 pg-boss ConstructorOptions 字段原样透传 */
  [key: string]: unknown;
}

/**
 * BullMQ 驱动选项（透传给 @faapi/task-bullmq）
 */
export interface TaskBullMqOptions {
  /** Redis 连接配置（透传给 Queue / Worker 的 connection） */
  connection?: {
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    [key: string]: unknown;
  };
  /** 队列名前缀（默认 `faapi`——同一 Redis 下多个 faapi 应用隔离用） */
  prefix?: string;
}

/**
 * 任务子系统配置
 *
 * 任务队列由持久化驱动承载（内置 memory 驱动已移除）：存在任务清单
 * （`src/tasks/` 下的 task.ts）时必须显式配置 `driver`，否则启动报错；
 * 无任务清单的项目不加载驱动（零任务项目无需安装驱动子包）。
 */
export interface TaskConfig {
  /**
   * 队列驱动：'pgboss'（@faapi/task-pgboss，Postgres）| 'bullmq'（@faapi/task-bullmq，Redis）
   *
   * 有任务清单时必填；也可在编程式场景传入自定义 TaskDriver 实例
   */
  driver?: 'pgboss' | 'bullmq';
  /** `driver: 'pgboss'` 时的选项（透传给 @faapi/task-pgboss） */
  pgboss?: TaskPgBossOptions;
  /** `driver: 'bullmq'` 时的选项（透传给 @faapi/task-bullmq） */
  bullmq?: TaskBullMqOptions;
  /**
   * 是否启动任务队列（默认 true）
   *
   * 多实例部署时可在非 worker 节点设 `FAAPI_TASKS_DISABLED=1` 或 `task.enabled: false`，
   * API 节点照常入队（入队能力保留），但不消费执行。
   */
  enabled?: boolean;
  /** 优雅停机时等待在跑任务的最长时间（毫秒，默认 10000；超时 abort） */
  shutdownTimeoutMs?: number;
  /**
   * 跨任务全局隔离 worker 并发上限（每进程独立限额）——单任务并发
   * （meta.concurrency，默认 1）只约束同名任务，N 个隔离任务并发时 worker 线程数
   * 累加抢核，预算在派发层统一封顶。默认 `max(1, os.availableParallelism() - 1)`
   * （预留 1 核给宿主事件循环）；超限的派发最多等待 30s，仍无席位则显式失败交驱动
   * 按 retries 重试（不无限排队——pgboss expire_in 会把等待中的执行判失联重投）。
   * 非法值（<1 或非整数）启动即报错
   */
  maxIsolatedWorkers?: number;
}

/**
 * 生命周期上下文
 */
export interface LifecycleContext {
  /** 项目根目录 */
  rootDir: string;
  /** 当前路由清单 */
  routes: import('../routers/routeTypes.js').RouteManifest;
  /** 服务器实例（onBoot 钩子触发时已创建但未监听，`listening === false`） */
  server: import('node:http').Server;
  /** app 级注册表（tool/agent/task 等，随 app 生命周期创建与销毁） */
  registries: import('../injection/registries.js').AppRegistries;
  /** 任务客户端——onBoot/onReady 中投递异步任务（`tasks.enqueue(name, payload)`） */
  tasks: import('../tasks/taskTypes.js').TaskClient;
  /**
   * faapi.config 全量配置（活引用）——与请求 `ctx.config` / 进程内任务
   * `taskCtx.config` 同一对象。钩子内读业务配置（含 `agent` 块复合形状经
   * `ctx.config.agent` 读回，可整体透传 `@faapi/agent` 的 createAgentDeps）
   */
  config: import('../runtime/contextTypes.js').FaapiContextConfig;
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
 * `config.agent.llms` 的 key 是 provider 名（如 `'openai'` / `'anthropic'`）。
 * 无全局默认 provider——每次 `agent.run/stream` 调用通过 `options.model`（llms key /
 * `provider/model` / 纯 model 名）或 `options.provider`（外部 provider）显式指定。
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
 * 提供 agent 子系统的全局配置，所有字段均可选。
 * 无全局默认 agent / 默认 provider——`agent.run/stream` 每次调用必须显式传
 * `options.agent`（agent 名）和 `options.model` / `options.provider`（LLM 定位）；
 * agent 自身 `config.maxTurns` / `config.model` 优先于全局配置，其中 `config.model`
 * 在调用未传 `options.model` 时作为缺省 key 参与 llms 解析。
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
 *     maxTurns: 10,
 *     maxAgentDepth: 3,
 *   },
 * } satisfies FaapiConfig;
 * ```
 *
 * 详见 `src/configs/configTypes.md` agent 配置块章节。
 */
export interface AgentConfig {
  /**
   * LLM provider 配置映射（Phase 3.5 改为嵌套级联结构，key 是 provider 名）
   *
   * 值是 [LlmConfig]（含 `models`）。plugin setup 时遍历每个 LlmConfig 调
   * `createProvider` 创建实例存 Map，handler 通过 `agent.run(input, { model })`
   * 切换 provider + model（详见 [agentHandle](../../agent/src/agentHandle.md)）。
   *
   * 可选——未设置时插件仍注册 agent handle 工厂（外部 provider 模式），
   * `agent.run/stream` 需通过 `options.provider` 传入外部 provider 才能调用 LLM。
   */
  llms?: Record<string, LlmConfig>;
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
   * 单次 tool 执行的超时毫秒数（未设置 = 不限时）
   *
   * 超时抛 `AgentToolTimeoutError`，被 reactLoop 按既有 tool 错误路径回传 LLM
   * （LLM 可决定重试或换路）——挂死的 tool handler（如无超时的内部 fetch）
   * 此前会让整个 run 永久挂起，且 run 的 abort signal 对 tool 执行无效。
   */
  toolTimeoutMs?: number;
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
   * 层级追踪 ID（默认 `true`——自动生成，详见 `@faapi/agent` 的
   * [traceId](../../agent/src/traceId.md) 文档）
   *
   * 每次根 `agent.run()` / `agent.stream()` 自动生成 12 位十六进制段作为 traceId，
   * sub-agent 派发链式续拼（父完整 ID + '.' + 新段），注入最终 system 消息末尾
   * （中性元数据措辞，指示 LLM 忽略）并在结果暴露（`result.traceId` / 流式
   * `done.traceId` / `trace.traceId`）——LLM 网关日志与业务日志按同一 ID 关联。
   *
   * `false` 整体关闭：不生成、不注入、结果无字段；单次调用显式传
   * `run(input, { traceId: ctx.requestId })` 时仍生效（显式优先）。
   */
  traceId?: boolean;
  /**
   * traceId 注入模板（缺省用英文默认文案，见 traceId.md）
   *
   * 必须含 `{traceId}` 占位符（渲染时替换为完整 ID），缺失时 run/stream 抛
   * `AgentError`（fail fast）。
   */
  traceIdTemplate?: string;
  /**
   * 发送给 LLM 的历史 token 预算（近似估算，未设置 = 不裁剪）
   *
   * 多轮 tool 循环中对话历史只增不减，大 tool 结果会撑爆模型上下文窗口导致
   * 下一轮 400。超预算时从最旧的轮组开始裁剪（system 与初始 user 保留、
   * tool 配对不拆散），只作用于发给 LLM 的消息副本。详见 @faapi/agent 的
   * reactLoop 文档历史裁剪章节。
   */
  maxHistoryTokens?: number;
  /**
   * 执行守卫/审计/可见性过滤（原 authHooks 三钩子 beforeToolCall/afterToolCall/
   * filterTools）与输入改写（原 resolveRootInput/resolveSubAgentInput）、提示词
   * 装饰（原 resolveSystemPrompt/resolveSubAgentContext）已全量事件化（7.x）——
   * 由 [appEventBus](../events/appEventBus.md) 的 `agent:before-tool-call` /
   * `agent:after-tool-call` / `agent:filter-tools` / `agent:system-prompt` /
   * `agent:sub-agent-context` / `agent:root-input` 等事件承载，订阅入口
   * `getApp().on`（`src/bootstrap.ts`）。
   */
  /**
   * 进程级 deps 配方（装饰钩子）——真实签名为
   * `(deps: AgentDeps) => AgentDeps`（`AgentDeps` 类型定义在 `@faapi/agent`，
   * 主包不反向依赖故此处按接受任意函数的手法声明；业务侧按真实签名书写即
   * 完全强类型，从 `@faapi/agent` 导入 `AgentDeps` 标注即可）。
   *
   * 在 `createAgentDeps` 装配的 base 之上、调用方显式 `overrides` 之前应用
   * （config 声明配方居中，显式 overrides 优先）——插件 setup 与业务自组装
   * 都走同一工厂，配方一次声明两路到达。典型用途：
   * - `resolveToolSchema` / `resolveAgentInputSchema`：schema 富化包装
   *   （条件必填注入 LLM 可见 JSON Schema，运行时校验链路不变）
   * - `providers` 复用：按 llms 引用缓存的进程级单例
   *
   * 装饰函数应当纯组装（spread + 覆盖差异项）；抛错原样冒泡（fail fast，
   * 不静默降级）。请求级差异不走本钩子——`ctx` 由工厂/组装调用方注入。
   */
  decorateDeps?: (...args: never[]) => unknown;
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
  cors?: import('../middlewares/cors.js').CorsOptions | boolean;

  /** 安全头配置，false 禁用 */
  helmet?: HelmetOptions | boolean;
  /**
   * 响应压缩（gzip/deflate/br 协商），默认关闭。
   * Vary: Accept-Encoding 自动附加；SSE/流式响应跳过，详见 middleware/compression.md
   */
  compression?: CompressionOptions | boolean;
  /**
   * ETag/304 条件请求协商（GET/HEAD 2xx 弱 ETag），默认关闭。
   * handler 显式 ctx.setETag() 时不覆盖，详见 middleware/etag.md
   */
  etag?: EtagOptions | boolean;
  /** 请求体大小限制（字节），默认 10MB（10 * 1024 * 1024） */
  bodyLimit?: number;
  /**
   * 日志全局配置——唯一日志配置入口，业务日志与请求日志同管道（egg 模型，
   * 详见 logger/logger.md；`config.logger` 独立配置已废除）
   *
   * - `false`：全部静默（含 error 与请求日志，测试降噪）
   * - `true` / 缺省：console 输出（consoleLevel 默认 'info'），管道不过滤
   * - `LogConfig`：`dir` egg 风格文件输出（app.log 全量 + error.log 仅 error，
   *   splitByLevel 按级别四文件）或 `sink` 自定义管道接管（接 pino/winston），
   *   两者互斥；`level` 管道阈值（不配不过滤）、`consoleLevel` console 出口阈值
   *   （不配 'info'，false 关 console）；请求日志无条件并入（`accessLog: false` 关闭）
   *
   * 生效范围：`ctx.log` / 参数注入 `log` / `createLogger` / `taskCtx.log` /
   * 请求日志中间件。日志全局配置是进程级资源，多 app 同进程时后启动覆盖先启动。
   *
   * ```ts
   * export default {
   *   log: {
   *     // 方式一：egg 风格文件输出（请求日志自动并入）
   *     dir: 'logs',
   *     // 方式二：自定义管道接管
   *     // sink: (entry) => pinoLogger[entry.level]({ scope: entry.scope, ...entry.fields }, entry.message),
   *   },
   * } satisfies FaapiConfig;
   * ```
   */
  log?: import('../loggers/loggerTypes.js').LogConfig | boolean;
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
   * 详见 `src/configs/configTypes.md` 统一响应包装章节。
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
   * 详见 `src/middlewares/README.md` 全局中间件章节。
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
   * 详见 `src/middlewares/README.md` 全局注入器章节。
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
   * 提供 agent 子系统的全局配置：LLM 提供方、最大对话轮数、
   * agent 调用 agent 的最大递归深度。
   *
   * 无全局默认 agent / 默认 provider——`agent.run/stream` 每次调用显式传
   * `options.agent` + `options.model` / `options.provider`。
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
   *     maxTurns: 10,
   *     maxAgentDepth: 3,
   *   },
   * } satisfies FaapiConfig;
   * ```
   *
   * 详见 `src/configs/configTypes.md` agent 配置块章节。
   */
  agent?: AgentConfig;

  /**
   * 任务子系统全局配置（队列驱动、启停、停机超时）
   *
   * ```ts
   * import type { FaapiConfig } from '@faapi/faapi';
   * export default {
   *   task: { enabled: true, shutdownTimeoutMs: 10_000 },
   * } satisfies FaapiConfig;
   * ```
   *
   * 详见 `src/tasks/README.md`。
   */
  task?: TaskConfig;

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
