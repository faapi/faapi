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
import type { RouteManifest, RouteMatch, WsRouteManifest, RoutesRef } from '../router/routeTypes';
import { matchRoute, findAllowedMethods } from '../router/matchRoute';
import { loadRouteModule } from '../loader/loadRouteModule';
import { createContextFromUrl } from '../runtime/createContext';
import { resolveInputFromUrl } from '../runtime/resolveInput';
import { invokeHandler, compose, mergeMeta } from '../runtime/invokeHandler';
import type { FaapiContext, ResponseMeta } from '../runtime/contextTypes';
import { sendNodeResponse } from '../response/sendNodeResponse';
import {
  RouteNotFoundError,
  MethodNotAllowedError,
  ValidationError,
  PayloadTooLargeError,
} from '../errors/httpErrors';
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
import { ensureSchemaGenerated, isDevOnDemandEnabled, getDevDist } from '../cli/compileOnDemand';
import { loadMergedMiddlewares } from '../middleware/loadMiddlewares';

/**
 * 将 Node.js IncomingMessage 转为 Web Request 对象
 *
 * 协议判断：
 * 1. 优先使用 X-Forwarded-Proto 头（反向代理场景）
 * 2. 回退到 http（HTTPS 由外部代理处理）
 */
const DEFAULT_BODY_LIMIT = 10 * 1024 * 1024; // 10MB

function toWebRequest(
  req: IncomingMessage,
  bodyLimit: number = DEFAULT_BODY_LIMIT,
): {
  request: Request;
  /** 已解析的 URL（pathname/searchParams 由调用方复用,免重复 new URL） */
  url: URL;
} {
  // 协议判断：优先 X-Forwarded-Proto（反向代理），否则 http
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwardedProto)
    ? (forwardedProto[0]?.split(',')[0]?.trim() ?? 'http')
    : (forwardedProto?.split(',')[0]?.trim() ?? 'http');
  const host = req.headers.host ?? 'localhost';
  // 全请求唯一一次 URL 解析——pathname/searchParams 由 ctx/routePipeline 复用
  const url = new URL(req.url ?? '/', `${protocol}://${host}`);

  const headers = nodeHttpToWebHeaders(req);

  const method = req.method ?? 'GET';

  // GET/HEAD 不应该有 body
  if (method === 'GET' || method === 'HEAD') {
    return { request: new Request(url.toString(), { method, headers }), url };
  }

  // content-length 快速判定：声明长度超限直接抛 PayloadTooLargeError,
  // 免去流包装 + 逐 chunk 读取（chunked 无此头,仍走 limitStreamSize 流式限流）
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    const declared = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
    if (Number.isFinite(declared) && declared > bodyLimit) {
      throw new PayloadTooLargeError(bodyLimit);
    }
  }

  // 将 Node.js IncomingMessage 转为 Web ReadableStream
  // 并限制请求体大小（防止 DoS）
  const stream = Readable.toWeb(req) as ReadableStream<Uint8Array>;
  const limitedStream = limitStreamSize(stream, bodyLimit);
  return {
    request: new Request(url.toString(), {
      method,
      headers,
      body: limitedStream,
      duplex: 'half',
    } as RequestInit),
    url,
  };
}

/**
 * 限制 ReadableStream 的总字节数，超过限制时通过 controller.error 抛 PayloadTooLargeError
 *
 * 错误传播路径：controller.error → Request body 读取方（resolveInput）抛 →
 * handleRequest catch → formatErrorResponse（命中 PayloadTooLargeError 分支）→ 413 响应
 *
 * 健壮性处理：
 * - reader.read() 抛错（客户端断开等）→ controller.error + releaseLock，避免泄漏
 * - 超限或异常后释放 reader lock，避免悬挂引用
 * - 取消时同步 cancel 上游 reader
 */
function limitStreamSize(
  stream: ReadableStream<Uint8Array>,
  maxSize: number,
): ReadableStream<Uint8Array> {
  let totalSize = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let errored = false;

  const releaseReader = (): void => {
    if (reader) {
      try {
        reader.releaseLock();
      } catch {
        // 锁已释放或 reader 已 closed，忽略
      }
      reader = undefined;
    }
  };

  const failStream = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    err: unknown,
  ): void => {
    if (errored) return;
    errored = true;
    controller.error(err instanceof Error ? err : new Error(String(err)));
    releaseReader();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!reader) reader = stream.getReader();
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          releaseReader();
          return;
        }
        totalSize += value.byteLength;
        if (totalSize > maxSize) {
          // error 让流进入 errored 状态，下游 read() 会 reject
          failStream(controller, new PayloadTooLargeError(maxSize));
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        // reader.read() 抛错（客户端断开、底层流异常等）
        failStream(controller, err);
      }
    },
    cancel(reason) {
      if (reader) {
        try {
          reader.cancel(reason);
        } catch {
          // 忽略上游 cancel 失败
        }
        releaseReader();
      }
    },
  });
}

/**
 * 查找路径的所有允许方法（用于 405 响应）
 *
 * 实现移至 [matchRoute](../router/matchRoute.ts)（共享路由索引：静态段 O(1) 直查,
 * 仅动态段线性扫描）。404 非热路径,但扫描器/探活探测的 404 高频场景下
 * 索引化仍有收益。
 */

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
  /**
   * 是否信任反向代理头（X-Forwarded-For），默认 false
   *
   * true 时 `ctx.ip` 取 `x-forwarded-for` 第一个 IP（nginx/CDN 场景）；
   * false（默认）时直取 socket 地址——直连部署下 XFF 可被伪造，安全默认不信任。
   */
  trustedProxy?: boolean;
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
    trustedProxy = false,
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

  // 外层中间件链启动期组装一次（CORS → helmet → logger → 全局），
  // 每请求不再重复 spread 重组数组
  const outerMiddlewares: FaapiMiddleware[] = [...configMiddlewares];
  if (globalMiddlewares && globalMiddlewares.length > 0) {
    outerMiddlewares.push(...globalMiddlewares);
  }

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
      outerMiddlewares,
      onError,
      config,
      globalInjectors,
      bodyLimit,
      trustedProxy,
    ).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });

  // 挂载 WebSocket 升级处理（仅当提供了 WS 路由）
  if (routesRef.wsCurrent.length > 0) {
    attachWebSocket({ server, routesRef, rootDir, config, globalMiddlewares, trustedProxy });
  }

  return { server, routesRef };
}

/**
 * 准备请求上下文：Node IncomingMessage → Web Request + FaapiContext
 *
 * 提取为独立函数，让 handleRequest 主流程聚焦于路由 + 中间件调度，
 * 便于单测与未来扩展（如自定义 context 字段来源）。
 *
 * URL 全请求只解析一次（toWebRequest 内），pathname/searchParams
 * 由 ctx / routePipeline 共享，避免一次请求重复 new URL 3~4 次。
 */
function prepareRequest(
  req: IncomingMessage,
  config: Record<string, unknown> | undefined,
  bodyLimit: number,
  trustedProxy: boolean,
): {
  request: Request;
  url: URL;
  ctx: FaapiContext;
  meta: ResponseMeta;
  method: string;
  urlPath: string;
} {
  const { request, url } = toWebRequest(req, bodyLimit);
  const method = request.method.toUpperCase();
  const urlPath = url.pathname;
  const ctx = createContextFromUrl(request, url, {}, config, getClientIp(req, trustedProxy));
  const meta = (ctx as FaapiContext & { meta: ResponseMeta }).meta;
  return { request, url, ctx, meta, method, urlPath };
}

/**
 * 路由匹配——命中返回 MatchResult，未命中抛 RouteNotFoundError / MethodNotAllowedError
 *
 * 抛错语义让调用方 try/catch 即可，无需在主流程里分支处理 null。
 */
function resolveRouteOrThrow(routes: RouteManifest, method: string, urlPath: string): RouteMatch {
  const match = matchRoute(routes, method, urlPath);
  if (match) return match;

  // 检查是否有其他方法匹配该路径 → 405
  const allowedMethods = findAllowedMethods(routes, urlPath);
  if (allowedMethods.length > 0) {
    throw new MethodNotAllowedError(method, urlPath, allowedMethods);
  }

  // 路由未匹配 → 404
  throw new RouteNotFoundError(urlPath);
}

/**
 * 路由执行管线：作为外层中间件链的 finalHandler
 *
 * 包含：路由匹配 → handler.js 加载 → 参数解析 → zod.js 按需生成 + 校验 →
 * 中间件按需加载 → 注入器合并 → handler 调用。
 *
 * 错误抛出由外层 handleRequest 的 try/catch 接管，经 formatErrorResponse 转换为响应。
 */
function createRoutePipeline(opts: {
  routes: RouteManifest;
  method: string;
  urlPath: string;
  url: URL;
  ctx: FaapiContext;
  request: Request;
  rootDir: string;
  dist: string;
  globalInjectors: InjectorMap | undefined;
}): () => Promise<Response> {
  const { routes, method, urlPath, url, ctx, request, rootDir, dist, globalInjectors } = opts;
  return async () => {
    // 1. 路由匹配（未命中抛 RouteNotFound / MethodNotAllowed）
    const match = resolveRouteOrThrow(routes, method, urlPath);
    ctx.params = match.params;
    const { route } = match;

    // 2. 加载 handler.js（dev 按需编译 + import，prod 直接 import）
    const absoluteFilePath = path.resolve(rootDir, route.filePath);
    const routeModule = await loadRouteModule(absoluteFilePath, route.method, rootDir);

    // 3. 参数解析（query / body / form / files 等）——复用已解析的 URL
    const input = await resolveInputFromUrl(route.method, request, url);

    // 4. schema 校验（运行时按 route.filePath 计算 zod.js 路径 + safeParse）
    const inputType = getInputTypeForMethod(route.method);
    const schemaPath = getRuntimeSchemaPath(route.filePath, dist, rootDir);

    // Dev 按需模式：zod.js 不存在或 stale 时触发按需生成
    if (isDevOnDemandEnabled()) {
      const devDist = getDevDist();
      if (devDist) {
        await ensureSchemaGenerated(schemaPath, route.filePath, routes, rootDir, dist);
      }
    }

    const result = await validateInput(schemaPath, route.method, inputType, input);
    if (!result.valid) {
      throw new ValidationError('参数校验失败', result.issues);
    }
    const body = hasBody(route.method) ? result.data : undefined;

    // 5. 中间件按需加载（Vite 风格）：route.middlewares 为 undefined 时从 middlewarePaths 加载
    //    首次请求加载后缓存到 route 上，后续请求直接复用
    if (route.middlewares === undefined && route.injectors === undefined && route.middlewarePaths) {
      const bundle = await loadMergedMiddlewares(route.middlewarePaths);
      if (bundle) {
        route.middlewares = bundle.middlewares;
        route.injectors = bundle.injectors;
      } else {
        // 标记为已加载（空中间件），避免重复加载
        route.middlewares = [];
        route.injectors = {};
      }
    }

    // 6. 注入器合并：全局注入器为基线，目录注入器覆盖同名
    const mergedInjectors = globalInjectors
      ? { ...globalInjectors, ...route.injectors }
      : route.injectors;

    // 7. handler 调用（含目录中间件洋葱模型 + 自动响应包装）
    return await invokeHandler(routeModule.handler, ctx, body, route.middlewares, mergedInjectors);
  };
}

/**
 * 发送成功响应
 */
async function sendSuccessResponse(response: Response, res: ServerResponse): Promise<void> {
  await sendNodeResponse(response, res);
}

/**
 * 发送错误响应 + 触发 onError 副作用
 *
 * 错误处理兜底链(参考 Fastify 语义):
 *   1. 框架内置 formatErrorResponse 兜底(handler 抛错时)——读 ctx.config.response.fail
 *      自定义包装函数,确保错误格式与 ctx.fail() 主动错误响应一致
 *   2. 内置兜底仍抛错 → 最简 500 JSON 响应
 *   3. 响应发出后 → onError 触发副作用(不修改已发出的响应)
 *   注:业务方如需进一步自定义错误响应,在全局中间件中 try/catch next() 即可
 *
 * `ctx` 可为 undefined——请求准备阶段抛错（如 content-length 超限）时尚未构造 ctx,
 * 此时错误格式用默认 fail 包装,onError 不触发（与原"裸 500"路径一致）。
 */
async function sendErrorResponse(
  err: unknown,
  meta: ResponseMeta,
  res: ServerResponse,
  onError: ((error: unknown, ctx: FaapiContext) => Promise<void> | void) | undefined,
  ctx: FaapiContext | undefined,
): Promise<void> {
  await sendNodeResponse(mergeMeta(buildErrorResponse(err, ctx?.config), meta), res);

  // 响应已发出，触发 onError 副作用（日志/告警/链路追踪），自身抛错被忽略
  if (onError && ctx) {
    try {
      await onError(err, ctx);
    } catch {
      // onError 自身抛错不影响已发出的响应
    }
  }
}

async function handleRequest(
  routes: RouteManifest,
  rootDir: string,
  dist: string,
  req: IncomingMessage,
  res: ServerResponse,
  outerMiddlewares: FaapiMiddleware[],
  onError: ((error: unknown, ctx: FaapiContext) => Promise<void> | void) | undefined,
  config: Record<string, unknown> | undefined,
  globalInjectors: InjectorMap | undefined,
  bodyLimit: number,
  trustedProxy: boolean,
): Promise<void> {
  // meta/ctx 兜底：请求准备阶段抛错（如 content-length 超限的 413）时尚无 ctx
  let meta: ResponseMeta = { headers: {}, setCookies: [] };
  let ctx: FaapiContext | undefined;
  try {
    // 1. 准备请求上下文（toWebRequest + createContext）——URL 全请求只解析一次
    const prepared = prepareRequest(req, config, bodyLimit, trustedProxy);
    ctx = prepared.ctx;
    meta = prepared.meta;
    const { request, url, method, urlPath } = prepared;

    // 2. 创建路由执行管线（路由匹配 + 校验 + 中间件加载 + handler 调用）
    const routePipeline = createRoutePipeline({
      routes,
      method,
      urlPath,
      url,
      ctx,
      request,
      rootDir,
      dist,
      globalInjectors,
    });

    // 3. 执行外层中间件链（CORS → helmet → logger → 全局 → routePipeline，
    //    数组已在 createServer 启动期组装，此处仅按需 compose）
    const response =
      outerMiddlewares.length > 0
        ? await compose(outerMiddlewares, ctx, routePipeline)
        : await routePipeline();
    // 4. 发送响应
    await sendSuccessResponse(response, res);
  } catch (err: unknown) {
    await sendErrorResponse(err, meta, res, onError, ctx);
  }
}
