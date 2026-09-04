export type { FaapiContext, FaapiContextConfig, FailOptions } from './runtime/contextTypes';
export type { FaapiMiddleware } from './middleware/middlewareTypes';
export type { Injector, InjectorMap } from './middleware/injectorTypes';
export type { CorsOptions } from './middleware/cors';
export type { LoggerOptions } from './middleware/logger';
export type { HelmetOptions } from './middleware/helmet';
export type {
  FaapiConfig,
  LifecycleHooks,
  LifecycleContext,
  ResponseConfig,
  AgentConfig,
  LlmConfig,
  LlmModelConfig,
} from './config/configTypes';
export type {
  FaapiPlugin,
  PluginContext,
  PluginDeclaration,
  RequestHandler,
  UpgradeHandler,
} from './config/pluginTypes';
export type { SseWriter, SseEvent } from './runtime/sse';
export type { WsContext, WsSocket, WsHandler, WsEventHandlers } from './runtime/wsHandler';
export type {
  RouteManifest,
  RouteInfo,
  RouteInputSchema,
  RouteOutputSchema,
  RouteParamSchema,
} from './router/routeTypes';

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
export type { AgentToolDescriptor } from './injection/agentRegistry';
export type { AgentModule } from './loader/loadAgentModule';
export type { ToolModule } from './loader/loadToolModule';
export type { ToolSchemaModule } from './loader/loadToolSchema';
// 注册表访问器（单例模块,createAppBase 水合后可直接 import 调用）
// getAgent 返回 AgentCore(LLM 可见字段);getAgentEntry 返回 AgentMetadata(含 filePath/hasRun,供加载 handler.js)
export {
  getAgent,
  getAgentEntry,
  resolveAgentTools,
  resolveSubAgents,
} from './injection/agentRegistry';
export { getTool } from './injection/toolRegistry';
// skill 注册表（运行时 DB-driven skills,业务方 plugin 接入外部源时调）
// skill 与 agent 物理隔离——agentRegistry 查询函数不 fallback 到 skillRegistry,
// skill 不参与 agent 查询链路、不覆盖文件型 agent、不参与 sub-agent 递归。
// 业务方 plugin 自行编排使用（如自定义注入器或中间件注入到 handler）。
export {
  hydrateSkillRegistry,
  upsertSkill,
  removeSkill,
  getSkill,
  listSkills,
} from './injection/skillRegistry';
// 动态加载器（dev 按需编译模式需 rootDir,prod 模式直接 import 产物）
export { loadAgentModule } from './loader/loadAgentModule';
export { loadToolModule } from './loader/loadToolModule';
export { loadToolSchema } from './loader/loadToolSchema';

// agent handle 工厂注册（Phase 3.5）——@faapi/agent 插件 setup 时注册,
// injectParams 在 agent 参数注入时调工厂获取 AgentHandle
export {
  registerAgentHandleFactory,
  clearAgentHandleFactory,
  type AgentHandleFactory,
} from './injection/agentHandle';

export { cors } from './middleware/cors';
export { logger } from './middleware/logger';
export { helmet } from './middleware/helmet';
export { loadConfig } from './config/loadConfig';
export { loadEnv } from './cli/loadEnv';

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
