import type { HttpMethod } from './constants';
import type { FaapiMiddleware } from '../middleware/middlewareTypes';
import type { InjectorMap } from '../middleware/injectorTypes';

export interface RouteRecord {
  method: HttpMethod;
  urlPath: string;
  filePath: string;
  paramNames: string[];
  isDynamic: boolean;
  /** 是否为 catch-all 路由（[...slug]） */
  isCatchAll?: boolean;
  /** 路由对应的中间件集合（从根到路由目录合并，构建时加载） */
  middlewares?: FaapiMiddleware[];
  /** 路由对应的注入器映射表（从根到路由目录合并，构建时加载） */
  injectors?: InjectorMap;
}

/**
 * WebSocket 路由记录
 *
 * 与 HTTP RouteRecord 类似，但不绑定 HTTP 方法（WS 是协议升级，不区分 GET/POST）。
 * 一个 handler.ts 中导出 WS 即生成一条 WS 路由记录。
 */
export interface WsRouteRecord {
  urlPath: string;
  filePath: string;
  paramNames: string[];
  isDynamic: boolean;
  /** 是否为 catch-all 路由（[...slug]） */
  isCatchAll?: boolean;
  /** 路由对应的中间件集合（握手阶段执行，复用鉴权/CORS/日志） */
  middlewares?: FaapiMiddleware[];
  /** 路由对应的注入器映射表 */
  injectors?: InjectorMap;
}

export type RouteManifest = RouteRecord[];
export type WsRouteManifest = WsRouteRecord[];

/**
 * 路由单个参数的 schema 描述
 *
 * 供 @faapi/schema 扩展包消费，通过 MCP 暴露给 LLM。
 */
export interface RouteParamSchema {
  name: string;
  type: string;
  required: boolean;
}

/**
 * 路由单个输入源的 schema 描述
 */
export interface RouteInputSchema {
  source: 'query' | 'body' | 'params';
  schemaName: string | null;
  properties: RouteParamSchema[];
}

/**
 * 路由的完整 schema 描述
 *
 * 由 @faapi/schema 扩展包的 buildRouteSchemas 生成。
 * 主包只定义类型契约，逻辑实现在扩展包。
 */
export interface RouteInfo {
  method: string;
  path: string;
  filePath: string;
  isDynamic: boolean;
  inputs: RouteInputSchema[];
}

export interface RouteMatch {
  route: RouteRecord;
  params: Record<string, string>;
}

/**
 * WebSocket 路由匹配结果
 */
export interface WsRouteMatch {
  route: WsRouteRecord;
  params: Record<string, string>;
}
