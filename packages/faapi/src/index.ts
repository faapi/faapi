export type { FaapiContext, FaapiContextConfig, FailOptions } from './runtime/contextTypes';
export type { FaapiMiddleware } from './middlewares/middlewareTypes';
export type { Injector, InjectorMap } from './middlewares/injectorTypes';
export type { CorsOptions } from './middlewares/cors';
export type { LoggerOptions } from './middlewares/logger';
export type { HelmetOptions } from './middlewares/helmet';
export type {
  FaapiConfig,
  LifecycleHooks,
  LifecycleContext,
  ResponseConfig,
  AgentConfig,
  LlmConfig,
  LlmModelConfig,
  TaskConfig,
  TaskPgBossOptions,
  TaskBullMqOptions,
} from './configs/configTypes';
export type {
  FaapiPlugin,
  PluginContext,
  PluginDeclaration,
  RequestHandler,
  UpgradeHandler,
} from './configs/pluginTypes';
export type { SseWriter, SseEvent, SseOptions } from './runtime/sse';
export type { WsContext, WsSocket, WsHandler, WsEventHandlers } from './runtime/wsHandler';
export type {
  RouteManifest,
  RouteInfo,
  RouteInputSchema,
  RouteOutputSchema,
  RouteParamSchema,
} from './routers/routeTypes';

// AST 能力（供 @faapi/schema 等扩展包复用）
export { createProgram, createPrograms, invalidateProgramCache } from './ast/createProgram';
export { extractTypeInfo, type HandlerTypeInfo } from './ast/extractHandlerTypes';
export type { RuntimeType, PropertyType, TypeConstraint } from './ast/resolveTypeNode';
export { SchemaExtractionError, resolveTypeNode } from './ast/resolveTypeNode';
export { getInputTypeForMethod } from './runtime/inputType';
export { collectRouteSchemaSources, type RouteSchemaSource } from './cli/collectRouteSchemaSources';

// agent 运行时集成面（供 @faapi/agent 等扩展包消费）
// 类型导出——描述返回结构,运行时擦除
// 运行时访问器——@faapi/agent 插件 setup 时导入,构造 AgentDeps 注入到 Agent 类
export type { AgentCore, AgentMetadata, AgentPathMeta } from './ast/extractAgentMetadata';
export type { ToolCore, ToolMetadata, ToolPathMeta } from './ast/extractToolMetadata';
export type { AgentToolDescriptor } from './injection/registries';
// app 级注册表（方案 A：实例化——每个 app 持有独立实例，全局函数为默认实例便捷访问器）
export type {
  AppRegistries,
  ToolRegistry,
  AgentRegistry,
  AgentHandleStore,
  AgentHandleFactory,
  TaskRegistriesView,
  LlmChannelStore,
} from './injection/registries';
export { createAppRegistries, createTaskRegistriesView } from './injection/registries';
// 轻量 LLM 补全通道规范类型（实现在 @faapi/agent 的 createLightComplete，见其 lightComplete.md）
export type { LlmComplete, LlmCompleteOptions } from './injection/llmTypes';
// 任务子系统（队列式异步任务，详见 src/tasks/README.md）
export type {
  FaapiTaskMeta,
  FaapiWorkerTaskMeta,
  TaskManifest,
  TaskMetadata,
  TaskJob,
  TaskJobStatus,
  TaskEvent,
  IsolatedTaskContext,
  TaskContext,
  TaskModule,
  IsolatedTaskModule,
  TaskClient,
  TaskQueue,
  TaskRegistriesSnapshot,
  TaskFailedInfo,
  TaskFailedHandler,
  TaskGroupSummary,
  TaskGroupSnapshot,
  TaskGroupOnFailure,
  TaskGroupOutcome,
} from './tasks/taskTypes';
export type { TaskRegistry } from './tasks/taskRegistry';
export type {
  TaskDriver,
  TaskDriverJob,
  TaskDriverProcess,
  TaskDriverRecord,
  TaskDriverGroupOps,
  TaskDriverGroupCreate,
  TaskDriverGroupSettleResult,
  TaskDriverTaskStateOps,
  TaskStateEntry,
  TaskResumeState,
} from './tasks/driverTypes';
export { createTaskRegistry } from './tasks/taskRegistry';
export { createTaskQueue } from './tasks/taskQueue';
export { loadTaskDriver } from './tasks/loadTaskDriver';
export { createCronScheduler, type CronScheduler } from './tasks/cronScheduler';
export { scanTasks, TASK_PATTERNS } from './tasks/scanTasks';
export type { ToolModule } from './loaders/loadToolModule';
export type { ToolSchemaModule, SchemaSourceRef } from './loaders/loadToolSchema';
// 注册表访问器（单例模块,createAppBase 水合后可直接 import 调用）
// getAgent 返回 AgentCore(LLM 可见字段);getAgentEntry 返回 AgentMetadata(含 filePath,声明文件定位)
export {
  getAgent,
  getAgentEntry,
  resolveAgentTools,
  resolveSubAgents,
} from './injection/agentRegistry';
export { getTool } from './injection/toolRegistry';
// sub-agent 派发工具名（agent-<agentName>）——OpenAI 兼容协议工具名字符集约束下的
// 唯一生成入口；authHooks（beforeToolCall/filterTools）用 SUB_AGENT_TOOL_PREFIX 判别
// sub-agent 调用，不硬编码前缀字符串
export {
  LLM_TOOL_NAME_PATTERN,
  SUB_AGENT_TOOL_PREFIX,
  subAgentToolName,
} from './injection/subAgentToolName';
// 动态加载器（dev 按需编译模式需 rootDir,prod 模式直接 import 产物）
export { loadToolModule } from './loaders/loadToolModule';
export { loadToolSchema, getToolSchemaPath } from './loaders/loadToolSchema';
// tool schema 解析工厂（zod.js → JSON Schema + safeParse 校验）——@faapi/agent 插件
// setup / 任务内组装 Agent / 测试设施 createAgentTestHarness 共用的装配实现
export { createToolSchemaResolver, type ToolSchemaResolution } from './loaders/toolSchemaResolver';

// agent handle 工厂注册（Phase 3.5）——@faapi/agent 插件 setup 时注册,
// injectParams 在 agent 参数注入时调工厂获取 AgentHandle
export { registerAgentHandleFactory, clearAgentHandleFactory } from './injection/agentHandle';

export { cors } from './middlewares/cors';
export { logger } from './middlewares/logger';
export { helmet } from './middlewares/helmet';
export { loadConfig } from './configs/loadConfig';
export { loadEnv } from './cli/loadEnv';
// 运行时资源安全读取（相对路径 + 只能读 resources 内文件，详见 src/utils/readResource.md）
// HTTP/WS handler、任务、插件、lifecycle 钩子等所有上下文统一用本免传参函数（读取根在 createAppBase 启动时绑定）
export { readResource } from './utils/readResource';

// 日志器（级别/scope/结构化字段/可插拔 sink，config.log 全局配置，详见 src/loggers/logger.md）
export { createLogger, configureLogging, flushLogging } from './loggers/logger';
export type {
  Logger,
  LogLevel,
  LogEntry,
  LogSink,
  LogConfig,
  CreateLoggerOptions,
} from './loggers/loggerTypes';

// 错误类（供业务侧 instanceof 判定与自定义错误中间件使用）
export {
  ValidationError,
  RouteNotFoundError,
  MethodNotAllowedError,
  InternalError,
  ModuleLoadError,
  type ValidationIssue,
  type ValidationErrorCode,
} from './errors/httpErrors';
export { FaapiError } from './errors/FaapiError';

// 高层编程式启动 API（参考 NestJS NestFactory.create()）
// dev/prod 拆分：createDevApp（含 reloadRoutes 热替换）/ createProdApp（精简）
// createApp 为 createProdApp 的向后兼容别名
export { createDevApp, type DevApp } from './cli/createDevApp';
export { createProdApp, type ProdApp } from './cli/createProdApp';
export { createApp, type App, type CreateAppOptions } from './cli/createApp';
export { getApp } from './cli/createAppCore';
export type { InjectOptions, InjectResponse } from './cli/createAppCore';

// runHub——交互式 run 传输中枢（run 与 HTTP 解耦 + 订阅式消费，详见 src/runhub/runHub.md）
export { createRunHub, RunConflictError } from './runhub/runHub';
export type {
  RunHub,
  RunHubOptions,
  RunHubEvent,
  RunHubPersistence,
  RunHandle,
  RunReplayPolicy,
  RunSubscribeOptions,
  RunSubscription,
} from './runhub/runHub';
