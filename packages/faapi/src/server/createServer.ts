import {
  createServer as createHttpServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createSecureServer as createHttp2SecureServer } from 'node:http2';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import type { RouteManifest, WsRouteManifest, RoutesRef } from '../router/routeTypes';
import { matchRoute, matchDynamicPath } from '../router/matchRoute';
import { loadRouteModule } from '../loader/loadRouteModule';
import { createContext } from '../runtime/createContext';
import { resolveInput } from '../runtime/resolveInput';
import { invokeHandler, compose, mergeMeta } from '../runtime/invokeHandler';
import type { FaapiContext, ResponseMeta } from '../runtime/contextTypes';
import { sendNodeResponse } from '../response/sendNodeResponse';
import { RouteNotFoundError, MethodNotAllowedError, ValidationError } from '../errors/httpErrors';
import { validateInput } from '../validator/validateInput';
import { getInputTypeForMethod, hasBody } from '../runtime/inputType';
import { getClientIp } from '../utils/getClientIp';
import { cors, type CorsOptions } from '../middleware/cors';
import { helmet, type HelmetOptions } from '../middleware/helmet';
import { logger as loggerMiddleware, type LoggerOptions } from '../middleware/logger';
import type { FaapiMiddleware } from '../middleware/middlewareTypes';
import type { InjectorMap } from '../middleware/injectorTypes';
import { attachWebSocket } from './handleWsUpgrade';
import { nodeHttpToWebHeaders, buildErrorResponse } from './serverUtils';
import { getRuntimeSchemaPath } from '../cli/generateSchemaFiles';

/**
 * 将 Node.js IncomingMessage 转为 Web Request 对象
 *
 * 协议判断：
 * 1. 优先使用 X-Forwarded-Proto 头（反向代理场景）
 * 2. 回退到 http（HTTPS 由外部代理处理）
 */
const DEFAULT_BODY_LIMIT = 10 * 1024 * 1024; // 10MB

function toWebRequest(req: IncomingMessage, bodyLimit: number = DEFAULT_BODY_LIMIT): Request {
  // 协议判断：优先 X-Forwarded-Proto（反向代理），否则 http
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwardedProto)
    ? (forwardedProto[0]?.split(',')[0]?.trim() ?? 'http')
    : (forwardedProto?.split(',')[0]?.trim() ?? 'http');
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `${protocol}://${host}`);

  const headers = nodeHttpToWebHeaders(req);

  const method = req.method ?? 'GET';

  // GET/HEAD 不应该有 body
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url.toString(), { method, headers });
  }

  // 将 Node.js IncomingMessage 转为 Web ReadableStream
  // 并限制请求体大小（防止 DoS）
  const stream = Readable.toWeb(req) as ReadableStream<Uint8Array>;
  const limitedStream = limitStreamSize(stream, bodyLimit);
  return new Request(url.toString(), {
    method,
    headers,
    body: limitedStream,
    duplex: 'half',
  } as RequestInit);
}

/**
 * 限制 ReadableStream 的总字节数，超过限制时抛错
 */
function limitStreamSize(
  stream: ReadableStream<Uint8Array>,
  maxSize: number,
): ReadableStream<Uint8Array> {
  let totalSize = 0;
  const reader = stream.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        reader.releaseLock();
        return;
      }
      totalSize += value.byteLength;
      if (totalSize > maxSize) {
        controller.error(new Error(`请求体超过大小限制 ${maxSize} 字节`));
        reader.releaseLock();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });
}

/**
 * 检查指定路径是否有其他方法的路由（用于 405 响应）
 */
function findAllowedMethods(routes: RouteManifest, path: string): string[] {
  const methods = new Set<string>();
  for (const route of routes) {
    if (route.urlPath === path) {
      methods.add(route.method);
      continue;
    }
    // 也检查动态路由
    if (route.isDynamic) {
      const params = matchDynamicPath(route.urlPath, path, route.paramNames, route.isCatchAll);
      if (params !== null) {
        methods.add(route.method);
      }
    }
  }
  return Array.from(methods);
}

export interface CreateServerOptions {
  routes: RouteManifest;
  rootDir: string;
  /** 产物输出目录（如 '.faapi' 或 'dist'），用于计算 schema 路径 */
  dist: string;
  cors?: CorsOptions | boolean;
  /** 请求错误钩子（在错误响应生成后调用，用于副作用；不修改已发出的响应） */
  onError?: (error: unknown, ctx: FaapiContext) => Promise<void> | void;
  /** 自定义业务配置（来自 faapi.config.ts，注入到 ctx.config） */
  config?: Record<string, unknown>;
  /** WebSocket 路由清单（空数组则不挂载 WS 支持） */
  wsRoutes?: WsRouteManifest;
  /** 全局中间件（来自 faapi.config.ts，对所有路由生效，最外层） */
  middlewares?: FaapiMiddleware[];
  /** 全局注入器（来自 faapi.config.ts，对所有路由 handler 参数注入生效） */
  injectors?: InjectorMap;
  /** 安全头配置 */
  helmet?: HelmetOptions | boolean;
  /** 请求日志配置,默认启用（与 cors 一致） */
  logger?: LoggerOptions | boolean;
  /** 请求体大小限制（字节） */
  bodyLimit?: number;
  /** HTTP/2 配置，启用时需提供 SSL 证书路径 */
  http2?: Http2Options | boolean;
}

export interface Http2Options {
  key?: string;
  cert?: string;
}

/**
 * 创建 faapi HTTP server
 *
 * @param options 路由清单、根目录
 * @returns Node.js Server 实例
 */
export function createServer(options: CreateServerOptions): {
  server: Server;
  routesRef: RoutesRef;
} {
  const {
    routes,
    rootDir,
    dist,
    cors: corsOption,
    onError,
    config,
    wsRoutes,
    middlewares: globalMiddlewares,
    injectors: globalInjectors,
    helmet: helmetOption,
    logger: loggerOption,
    bodyLimit = DEFAULT_BODY_LIMIT,
    http2: http2Option,
  } = options;

  // 路由可变引用容器（watch 模式热替换时 reloadRoutes 更新 .current/.wsCurrent）
  const routesRef: RoutesRef = { current: routes, wsCurrent: wsRoutes ?? [] };

  // Build middleware chain from config options
  const configMiddlewares: FaapiMiddleware[] = [];

  // CORS
  const corsMiddleware: FaapiMiddleware | null =
    corsOption === false
      ? null
      : corsOption === true || corsOption === undefined
        ? cors()
        : cors(corsOption);
  if (corsMiddleware) configMiddlewares.push(corsMiddleware);

  // Helmet — enabled only when explicitly configured
  if (helmetOption) {
    const helmOpts = typeof helmetOption === 'object' ? helmetOption : {};
    configMiddlewares.push(helmet(helmOpts));
  }

  // Logger — 默认启用（与 cors 一致），false 禁用，LoggerOptions 自定义
  const loggerMiddlewareInst: FaapiMiddleware | null =
    loggerOption === false
      ? null
      : loggerOption === true || loggerOption === undefined
        ? loggerMiddleware()
        : loggerMiddleware(loggerOption);
  if (loggerMiddlewareInst) configMiddlewares.push(loggerMiddlewareInst);

  const server = ((): Server => {
    if (http2Option) {
      const h2Opts = typeof http2Option === 'object' ? http2Option : {};
      return createHttp2SecureServer({
        key: h2Opts.key ? readFileSync(h2Opts.key) : undefined,
        cert: h2Opts.cert ? readFileSync(h2Opts.cert) : undefined,
        allowHTTP1: true,
      }) as unknown as Server;
    }
    return createHttpServer();
  })();

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    // 每次请求读取最新的路由状态（支持 watch 模式热更新）
    const currentRoutes = routesRef.current;

    handleRequest(
      currentRoutes,
      rootDir,
      dist,
      req,
      res,
      configMiddlewares,
      onError,
      config,
      globalMiddlewares,
      globalInjectors,
      bodyLimit,
    ).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });

  // 挂载 WebSocket 升级处理（仅当提供了 WS 路由）
  if (routesRef.wsCurrent.length > 0) {
    attachWebSocket({ server, routesRef, rootDir, config, globalMiddlewares });
  }

  return { server, routesRef };
}

async function handleRequest(
  routes: RouteManifest,
  rootDir: string,
  dist: string,
  req: IncomingMessage,
  res: ServerResponse,
  configMiddlewares: FaapiMiddleware[],
  onError: ((error: unknown, ctx: FaapiContext) => Promise<void> | void) | undefined,
  config: Record<string, unknown> | undefined,
  globalMiddlewares: FaapiMiddleware[] | undefined,
  globalInjectors: InjectorMap | undefined,
  bodyLimit: number,
): Promise<void> {
  const request = toWebRequest(req, bodyLimit);
  const method = request.method.toUpperCase();
  const urlPath = new URL(request.url).pathname;
  const ctx = createContext(request, {}, config, getClientIp(req));
  const meta = (ctx as FaapiContext & { meta: ResponseMeta }).meta;

  // 路由处理管线：作为 CORS 中间件的 next
  // 包含路由匹配、静态文件、参数校验、handler 调用、响应格式化
  const routePipeline = async (): Promise<Response> => {
    // 尝试匹配路由
    const match = matchRoute(routes, method, urlPath);

    if (!match) {
      // 检查是否有其他方法匹配该路径
      const allowedMethods = findAllowedMethods(routes, urlPath);
      if (allowedMethods.length > 0) {
        throw new MethodNotAllowedError(method, urlPath, allowedMethods);
      }

      // 路由未匹配，返回 404
      throw new RouteNotFoundError(urlPath);
    }

    // 匹配成功，填充路由参数
    ctx.params = match.params;
    const { route } = match;

    // 处理 API 路由（handler.ts）
    const absoluteFilePath = path.resolve(rootDir, route.filePath);
    const routeModule = await loadRouteModule(absoluteFilePath, route.method);
    const input = await resolveInput(route.method, request);

    // 参数校验（运行时按 route.filePath 计算 zod.js 路径，import 并 safeParse）
    const inputType = getInputTypeForMethod(route.method);
    const schemaPath = getRuntimeSchemaPath(route.filePath, dist, rootDir);
    const result = await validateInput(schemaPath, route.method, inputType, input);
    if (!result.valid) {
      throw new ValidationError('参数校验失败', result.issues);
    }

    const body = hasBody(route.method) ? result.data : undefined;
    // 合并注入器：全局注入器为基线，目录注入器覆盖同名
    const mergedInjectors = globalInjectors
      ? { ...globalInjectors, ...route.injectors }
      : route.injectors;
    const response = await invokeHandler(
      routeModule.handler,
      ctx,
      body,
      route.middlewares,
      mergedInjectors,
    );

    return response;
  };

  try {
    let response: Response;
    // 外层中间件链：配置中间件（CORS/helmet/logger）+ 全局中间件
    // 顺序：CORS → helmet → logger → 全局 → routePipeline（含目录中间件 + handler）
    const outerMiddlewares: FaapiMiddleware[] = [];
    if (configMiddlewares.length > 0) outerMiddlewares.push(...configMiddlewares);
    if (globalMiddlewares && globalMiddlewares.length > 0) {
      outerMiddlewares.push(...globalMiddlewares);
    }

    if (outerMiddlewares.length > 0) {
      response = await compose(outerMiddlewares, ctx, routePipeline);
    } else {
      response = await routePipeline();
    }
    await sendNodeResponse(response, res);
  } catch (err: unknown) {
    // 错误处理兜底链(参考 Fastify 语义):
    //   1. 框架内置 formatErrorResponse 兜底(handler 抛错时)
    //   2. 内置兜底仍抛错 → 最简 500 JSON 响应
    //   3. 响应发出后 → onError 触发副作用(不修改已发出的响应)
    //   注:业务方如需自定义错误响应,在全局中间件中 try/catch next() 即可
    const errorResponse = buildErrorResponse(err);
    await sendNodeResponse(mergeMeta(errorResponse, meta), res);

    // 响应已发出，触发 onError 副作用（日志/告警），自身抛错被忽略
    if (onError) {
      try {
        await onError(err, ctx);
      } catch {
        // onError 自身抛错不影响已发出的响应
      }
    }
  }
}
