export type { FaapiContext, FaapiContextConfig } from './runtime/contextTypes';
export type { FaapiMiddleware } from './middleware/middlewareTypes';
export type { Injector, InjectorMap } from './middleware/injectorTypes';
export type { CorsOptions } from './middleware/cors';
export type { LoggerOptions } from './middleware/logger';
export type { HelmetOptions } from './middleware/helmet';
export type {
  FaapiConfig,
  ResponseFormatFn,
  ErrorFormatFn,
  LifecycleHooks,
  LifecycleContext,
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
  RouteParamSchema,
} from './router/routeTypes';

// AST 能力（供 @faapi/schema 等扩展包复用）
export { createProgram, invalidateProgramCache } from './ast/createProgram';
export { extractTypeInfo, type HandlerTypeInfo } from './ast/extractHandlerTypes';
export type { RuntimeType, PropertyType } from './ast/resolveTypeNode';
export { SchemaExtractionError } from './ast/resolveTypeNode';
export { getInputTypeForMethod } from './runtime/inputType';
export { collectRouteSchemaSources, type RouteSchemaSource } from './cli/collectRouteSchemaSources';

export { cors } from './middleware/cors';
export { logger } from './middleware/logger';
export { helmet } from './middleware/helmet';
export { loadConfig } from './config/loadConfig';

// 高层编程式启动 API（参考 NestJS NestFactory.create()）
// dev/prod 拆分：createDevApp（含 reloadRoutes 热替换）/ createProdApp（精简）
// createApp 为 createProdApp 的向后兼容别名
export { createDevApp, type DevApp } from './cli/createDevApp';
export { createProdApp, type ProdApp } from './cli/createProdApp';
export { createApp, type App, type CreateAppOptions } from './cli/createApp';
export type { InjectOptions, InjectResponse } from './cli/createAppCore';
