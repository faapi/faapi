import {
  createServer as createHttpServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
import path from 'node:path';
import type { RouteManifest, WsRouteManifest } from '../router/routeTypes';
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
import type { FaapiMiddleware } from '../middleware/middlewareTypes';
import type { InjectorMap } from '../middleware/injectorTypes';
import type { ResponseFormatFn, ErrorFormatFn } from '../config/configTypes';
import { serveStatic } from './serveStatic';
import { schemaRegistry } from '../validator/schemaRegistry';
import { extractSchemasForRoutes } from '../cli/generateSchema';
import { attachWebSocket } from './handleWsUpgrade';
import { nodeHttpToWebHeaders, buildErrorResponse } from './serverUtils';

/**
 * 将 Node.js IncomingMessage 转为 Web Request 对象
 *
 * 协议判断：
 * 1. 优先使用 X-Forwarded-Proto 头（反向代理场景）
 * 2. 回退到 http（HTTPS 由外部代理处理）
 *
 * 请求体大小限制：10MB（防止 DoS）
 */
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

function toWebRequest(req: IncomingMessage): Request {
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
  const limitedStream = limitStreamSize(stream, MAX_BODY_SIZE);
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
  cors?: CorsOptions | boolean; // true = dev mode auto-enable, false = disabled
  staticDir?: string;
  /** 统一响应格式化函数 */
  responseFormat?: ResponseFormatFn;
  /** 错误响应格式化函数（优先于内置 formatErrorResponse 处理；返回 null/undefined 表示不处理） */
  errorFormat?: ErrorFormatFn;
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
}

/**
 * 创建 faapi HTTP server
 *
 * @param options 路由清单、根目录
 * @returns Node.js Server 实例
 */
export function createServer(options: CreateServerOptions): Server {
  const {
    routes,
    rootDir,
    cors: corsOption,
    staticDir,
    responseFormat,
    errorFormat,
    onError,
    config,
    wsRoutes,
    middlewares: globalMiddlewares,
    injectors: globalInjectors,
  } = options;

  // 初始化全局路由状态（watch 模式会更新这些值）
  const globalRef = globalThis as Record<string, unknown>;
  globalRef.__FAAPI_ROUTES__ = routes;
  if (wsRoutes) {
    globalRef.__FAAPI_WS_ROUTES__ = wsRoutes;
  }

  // 确保 schema 已注册到 registry
  // - 如果 registry 已有数据（startCommand 已加载 manifest 或 dev 已提取），跳过
  // - 如果 registry 为空（e2e 测试或直接调用 createServer），自动提取
  if (schemaRegistry.size === 0 && routes.length > 0) {
    const manifest = extractSchemasForRoutes(routes, rootDir);
    schemaRegistry.loadManifest(manifest);
  }

  // Build CORS middleware if enabled
  const corsMiddleware: FaapiMiddleware | null =
    corsOption === false
      ? null
      : corsOption === true || corsOption === undefined
        ? cors() // default: allow all (dev mode)
        : cors(corsOption);

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    // 每次请求读取最新的路由状态（支持 watch 模式热更新）
    const currentRoutes = (globalRef.__FAAPI_ROUTES__ as RouteManifest) ?? routes;

    handleRequest(
      currentRoutes,
      rootDir,
      req,
      res,
      corsMiddleware,
      staticDir,
      responseFormat,
      errorFormat,
      onError,
      config,
      globalMiddlewares,
      globalInjectors,
    ).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });

  // 挂载 WebSocket 升级处理（仅当提供了 WS 路由）
  if (wsRoutes && wsRoutes.length > 0) {
    attachWebSocket({ server, wsRoutes, rootDir, config, errorFormat, globalMiddlewares });
  }

  return server;
}

async function handleRequest(
  routes: RouteManifest,
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  corsMiddleware: FaapiMiddleware | null,
  staticDir: string | undefined,
  responseFormat: ResponseFormatFn | undefined,
  errorFormat: ErrorFormatFn | undefined,
  onError: ((error: unknown, ctx: FaapiContext) => Promise<void> | void) | undefined,
  config: Record<string, unknown> | undefined,
  globalMiddlewares: FaapiMiddleware[] | undefined,
  globalInjectors: InjectorMap | undefined,
): Promise<void> {
  const request = toWebRequest(req);
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
      // 静态文件 fallback
      if (staticDir) {
        const absStaticDir = path.resolve(rootDir, staticDir);
        const staticResponse = await serveStatic(urlPath, absStaticDir);
        if (staticResponse) {
          return mergeMeta(staticResponse, meta);
        }
      }

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

    // 参数校验（统一从 inputType 模块获取输入类型）
    const inputType = getInputTypeForMethod(route.method);
    const result = await validateInput(absoluteFilePath, route.method, inputType, input);
    if (!result.valid) {
      throw new ValidationError('参数校验失败', result.issues);
    }

    const body = hasBody(route.method) ? result.data : undefined;
    // 合并注入器：全局注入器为基线，目录注入器覆盖同名
    const mergedInjectors = globalInjectors
      ? { ...globalInjectors, ...route.injectors }
      : route.injectors;
    let response = await invokeHandler(
      routeModule.handler,
      ctx,
      body,
      route.middlewares,
      mergedInjectors,
    );

    // 统一响应格式化：对非 Response 的成功响应应用 responseFormat
    if (responseFormat && response.status >= 200 && response.status < 300) {
      // 只对 JSON 响应（handler 返回的对象）应用格式化，跳过 Response 原样透传的情况
      const contentType = response.headers.get('Content-Type') ?? '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        const formatted = responseFormat(data, ctx);
        // 重新构建响应（保留原有 meta 信息）
        const { toResponse } = await import('../response/toResponse.js');
        response = await toResponse(formatted, meta);
      }
    }

    return response;
  };

  try {
    let response: Response;
    // 外层中间件链：CORS + 全局中间件（CORS 最外，全局次外）
    // 顺序：CORS.before → 全局.before → routePipeline（含目录中间件 + handler）→ 全局.after → CORS.after
    const outerMiddlewares: FaapiMiddleware[] = [];
    if (corsMiddleware) outerMiddlewares.push(corsMiddleware);
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
    // 错误处理兜底链（参考 Fastify 语义）：
    //   1. 用户 errorFormat 返回 Response 表示已处理
    //   2. errorFormat 未处理（返回 null/undefined）或抛错 → 框架内置 formatErrorResponse 兜底
    //   3. 内置兜底仍抛错 → 最简 500 JSON 响应
    //   4. 响应发出后 → onError 触发副作用（不修改已发出的响应）
    const errorResponse = buildErrorResponse(err, ctx, errorFormat);
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
