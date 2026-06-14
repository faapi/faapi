export type { FaapiContext, FaapiContextConfig } from './runtime/contextTypes';
export type { FaapiMiddleware } from './middleware/middlewareTypes';
export type { Injector, InjectorMap } from './middleware/injectorTypes';
export type { CorsOptions } from './middleware/cors';
export type { LoggerOptions } from './middleware/logger';
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
export { createProgram } from './ast/createProgram';
export { extractTypeInfo, type HandlerTypeInfo } from './ast/extractHandlerTypes';
export type { RuntimeType, PropertyType } from './ast/resolveTypeNode';
export { SchemaExtractionError } from './ast/resolveTypeNode';
export { getInputTypeForMethod } from './runtime/inputType';
export {
  getSchemaProperties,
  type SchemaPropertyDescriptor,
  type InputSchemaDescriptor,
} from './validator/getSchemaProperties';

export { cors } from './middleware/cors';
export { logger } from './middleware/logger';
export { loadConfig } from './config/loadConfig';
