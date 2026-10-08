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
import { resolveInputFromUrl, resolveBodyForQueryMethod } from '../runtime/resolveInput';
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
import { queryToObject } from '../utils/queryToObject';
import { getClientIp } from '../utils/getClientIp';
import { cors, type CorsOptions } from '../middleware/cors';
import { helmet, type HelmetOptions } from '../middleware/helmet';
import { compression, type CompressionOptions } from '../middleware/compression';
import { etag, type EtagOptions } from '../middleware/etag';
import type { AppRegistries } from '../injection/registries';
import { logger as loggerMiddleware } from '../middleware/logger';
import type { FaapiMiddleware } from '../middleware/middlewareTypes';
import type { InjectorMap } from '../middleware/injectorTypes';
import { attachWebSocket } from './handleWsUpgrade';
import { nodeHttpToWebHeaders, buildErrorResponse } from './serverUtils';
import { getRuntimeSchemaPath } from '../cli/generateSchemaFiles';
import {
  ensureSchemaGenerated,
  ensureMiddlewaresCompiled,
  isDevOnDemandEnabled,
  getDevDist,
} from '../cli/compileOnDemand';
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
  requestSignal?: AbortSignal,
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
    return {
      request: new Request(url.toString(), { method, headers, signal: requestSignal }),
      url,
    };
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
      signal: requestSignal,
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
  /** 响应压缩（gzip/deflate/br 协商），默认关闭，详见 middleware/compression.md */
  compression?: CompressionOptions | boolean;
  /** ETag/304 条件请求协商，默认关闭，详见 middleware/etag.md */
  etag?: EtagOptions | boolean;
  /** app 级注册表（tool/agent/skill/agentHandle）——经 FaapiContext 进入请求链路 */
  registries?: AppRegistries;
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
    compression: compressionOption,
    etag: etagOption,
    registries,
    bodyLimit = DEFAULT_BODY_LIMIT,
    http2: http2Option,
    trustedProxy = false,
  } = options;

  // 路由可变引用容器（watch 模式热替换时 reloadRoutes 更新 .current/.wsCurrent）
  const routesRef: RoutesRef = { current: routes, wsCurrent: wsRoutes ?? [] };

  // Build middleware chain from config options
  const configMiddlewares: FaapiMiddleware[] = [];

  // Compression — 显式启用；链最外层，包住完整链路使最终响应被压缩
  if (compressionOption) {
    const compOpts = typeof compressionOption === 'object' ? compressionOption : {};
    configMiddlewares.push(compression(compOpts));
  }

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

  // Logger — 默认启用，请求日志无条件并入统一日志管道（config.log.accessLog: false 关闭，
  // config.log: false 随管道全静默；编程式自定义输出经 middlewares: [logger({ log })]
  configMiddlewares.push(loggerMiddleware());

  // ETag — 显式启用；位于 compression 内层：先算 ETag/304 再压缩，
  // 弱 ETag 基于未压缩表示计算（304 无 body 时压缩自动跳过）
  if (etagOption) {
    const etagOpts = typeof etagOption === 'object' ? etagOption : {};
    configMiddlewares.push(etag(etagOpts));
  }

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
      registries,
      routesRef.wsCurrent,
    ).catch((err) => {
      // 兜底留痕：进入这里说明 sendErrorResponse 自身也失败（如响应头已发的二次
      // 响应尝试），恰恰是最需要排查痕迹的极端场景，静默吞掉会让 500 无从定位
      console.error('[faapi] Request pipeline failed after error response attempt:', err);
      try {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        } else if (!res.writableEnded) {
          res.end();
        }
      } catch {
        // 连接已不可用，忽略
      }
    });
  });

  // 挂载 WebSocket 升级处理（无条件挂载：upgrade 处理器内部对无匹配路由返回 404，
  // 空清单成本一次函数调用。若按初始清单条件挂载，dev watch 中新增第一个 WS 路由后
  // upgrade 监听器不会补挂，WS 路由永远 404）
  attachWebSocket({
    server,
    routesRef,
    rootDir,
    dist,
    config,
    globalMiddlewares,
    trustedProxy,
    registries,
  });

  return { server, routesRef };
}

/**
 * 准备请求上下文：已解析的 Web Request + FaapiContext
 *
 * 提取为独立函数，让 handleRequest 主流程聚焦于路由 + 中间件调度，
 * 便于单测与未来扩展（如自定义 context 字段来源）。
 *
 * Web Request / URL 由调用方（handleRequest）解析一次后传入——提前路由匹配
 * 需要在构造 ctx 之前拿到 method/urlPath，且 Request 的 body 流只能包装一次。
 *
 * preMatched：提前匹配的路由结果（handleRequest 在构造 ctx 前完成匹配，
 * 让全局中间件 next() 之前即可见 ctx.params/ctx.rawParams 原始段）。
 * 未命中传 null——ctx.params 挂空对象，404/405 仍由 routePipeline 抛出
 * （错误响应保持经过完整外层中间件链，CORS 头不丢）。
 */
function prepareRequest(
  req: IncomingMessage,
  request: Request,
  url: URL,
  config: Record<string, unknown> | undefined,
  trustedProxy: boolean,
  registries?: AppRegistries,
  preMatched?: RouteMatch | null,
): {
  request: Request;
  url: URL;
  ctx: FaapiContext;
  meta: ResponseMeta;
  method: string;
  urlPath: string;
} {
  const method = request.method.toUpperCase();
  const urlPath = url.pathname;
  // 路由匹配后构造 ctx：params 初值即匹配的原始段（全局中间件 next() 前可见），
  // createContext 内部把 params 同时挂为 ctx.rawParams（恒原始引用）
  const ctx = createContextFromUrl(
    request,
    url,
    preMatched?.params ?? {},
    config,
    getClientIp(req, trustedProxy),
    registries,
  );
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
// 路由静态派生路径缓存（绝对路径 / schema 路径对固定 route 恒定,免每请求字符串运算）。
// WeakMap 按 route 对象弱键——reloadRoutes 整体替换清单后旧对象可 GC,无需手动失效
const routePathCache = new WeakMap<
  RouteManifest[number],
  { absFilePath: string; schemaPath: string }
>();

function getRoutePaths(
  route: RouteManifest[number],
  rootDir: string,
  dist: string,
): { absFilePath: string; schemaPath: string } {
  let cached = routePathCache.get(route);
  if (!cached) {
    cached = {
      absFilePath: path.resolve(rootDir, route.filePath),
      schemaPath: getRuntimeSchemaPath(route.filePath, dist, rootDir),
    };
    routePathCache.set(route, cached);
  }
  return cached;
}

/** 合并注入器缓存（route 记录 → 全局+目录合并结果；route 记录 reload 即换代） */
const mergedInjectorsCache = new WeakMap<object, InjectorMap>();

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
  /** 提前匹配的路由结果；null 时由本管线抛 404/405（保持错误经过全局中间件链） */
  preMatched: RouteMatch | null;
  /** WS 路由清单（同文件 WS 路由的 schema 一并按需生成，防静默缺失） */
  wsRoutes?: WsRouteManifest;
}): () => Promise<Response> {
  const {
    routes,
    method,
    urlPath,
    url,
    ctx,
    request,
    rootDir,
    dist,
    globalInjectors,
    preMatched,
    wsRoutes,
  } = opts;
  return async () => {
    // 1. 路由匹配：命中已在 handleRequest 提前完成（ctx.params/rawParams 已挂原始段）；
    //    未命中在此抛 RouteNotFound / MethodNotAllowed
    const match = preMatched ?? resolveRouteOrThrow(routes, method, urlPath);
    const { route } = match;
    const { absFilePath, schemaPath } = getRoutePaths(route, rootDir, dist);

    // 2. 加载 handler.js（dev 按需编译 + import，prod 直接 import）
    const routeModule = await loadRouteModule(absFilePath, route.method, rootDir);

    // 3. 参数解析（query / body / form / files 等）——复用已解析的 URL；
    //    rawBody（请求体原始文本）随之挂载（GET/HEAD 与 multipart 为 undefined）
    const { input, rawBody } = await resolveInputFromUrl(route.method, request, url);
    if (rawBody !== undefined) {
      ctx.rawBody = rawBody;
    }

    // 4. schema 校验（运行时按 route.filePath 计算 zod.js 路径 + safeParse）
    const inputType = getInputTypeForMethod(route.method);
    // schemaPath 已在 getRoutePaths 中缓存

    // Dev 按需模式：zod.js 不存在或 stale 时触发按需生成
    if (isDevOnDemandEnabled()) {
      const devDist = getDevDist();
      if (devDist) {
        await ensureSchemaGenerated(schemaPath, route.filePath, routes, rootDir, dist, wsRoutes);
      }
    }

    const result = await validateInput(schemaPath, route.method, inputType, input);
    if (!result.valid) {
      throw new ValidationError('参数校验失败', result.issues);
    }

    // 主输入是 query 的方法（GET/DELETE/HEAD）：校验后的值替换 ctx.query
    //（声明 number/boolean 的字段已是转换后的值）。以原始 query 打底合并——
    // schema 是 z.object，声明之外的字段会被剥掉，未声明的兜底键保持原始
    // 字符串，行为与未声明 schema 时一致。ctx.query 即 handler 的 query 注入
    //（同一对象），无声明时 validateInput 原样透传、不替换。
    if (
      inputType === 'query' &&
      result.data !== input &&
      typeof result.data === 'object' &&
      result.data !== null
    ) {
      ctx.query = {
        ...(input as Record<string, unknown>),
        ...(result.data as Record<string, unknown>),
      };
    }

    // params 校验与回写：handler 声明了 `params: XxxParams` 时按声明类型校验
    // 路径参数（number/boolean 由 schema 内联 coerce 完成字符串→值转换），并把
    // 转换后的值回写 ctx.params——handler 注入、目录/全局中间件与诊断日志拿到的
    // 都是转换后的值。同样以原始 params 打底合并（防 catch-all 等声明之外的段被
    // z.object 剥掉）；ctx.rawParams 保持原始引用不受影响。无声明时 validateInput
    // 原样透传，回写等于无操作。
    const paramsResult = await validateInput(schemaPath, route.method, 'params', match.params);
    if (!paramsResult.valid) {
      throw new ValidationError('参数校验失败', paramsResult.issues);
    }
    if (paramsResult.data !== match.params) {
      ctx.params =
        typeof paramsResult.data === 'object' && paramsResult.data !== null
          ? {
              ...match.params,
              ...(paramsResult.data as Record<string, string | number | boolean>),
            }
          : match.params;
    }

    // 次输入校验（声明即校验，与主输入同一 validateInput 通道）：
    // body 方法（POST/PUT/PATCH）声明 query 形参时存在 POSTQuery schema——校验 query
    // 并替换 ctx.query（声明字段拿到转换值，未声明字段以原始 query 打底保留
    // 原始字符串）；无声明时 schema 缺失、data === input，不替换，ctx.query 保持
    // createContext 挂载的原始 query 对象。
    if (inputType === 'body') {
      const rawQuery = queryToObject(url.searchParams);
      const queryResult = await validateInput(schemaPath, route.method, 'query', rawQuery);
      if (!queryResult.valid) {
        throw new ValidationError('参数校验失败', queryResult.issues);
      }
      if (
        queryResult.data !== rawQuery &&
        typeof queryResult.data === 'object' &&
        queryResult.data !== null
      ) {
        ctx.query = {
          ...(rawQuery as Record<string, unknown>),
          ...(queryResult.data as Record<string, unknown>),
        };
      }
    }
    // body 计算与主输入分流：
    // - POST/PUT/PATCH：主输入就是 body，用校验后的值
    // - DELETE：主输入是 query（校验 DELETEQuery），body 单独解析注入——
    //   若把校验后的 query 当 body 传入，handler 声明 body 会静默拿到 query；
    //   同时请求体流不被消费，keep-alive 连接无法复用。
    //   声明 body/form 形参时存在 DELETEBody schema：解析结果校验后再注入
    //   （Date 字段转换与 POST body 一致；form 声明 coerce=true）。空请求体
    //   （null）与 POST 同路径：有 schema 时 safeParse 失败 422，无 schema 透传
    // - GET/HEAD：无 body
    let body: unknown;
    if (inputType === 'query' && hasBody(route.method)) {
      const parsed = await resolveBodyForQueryMethod(request);
      if (parsed.rawBody !== undefined) {
        ctx.rawBody = parsed.rawBody;
      }
      const bodyResult = await validateInput(schemaPath, route.method, 'body', parsed.input);
      if (!bodyResult.valid) {
        throw new ValidationError('参数校验失败', bodyResult.issues);
      }
      body = bodyResult.data;
    } else if (hasBody(route.method)) {
      body = result.data;
    }
    // 挂载校验后的 body：目录中间件（handler 之前）可经 ctx.body 读取请求体；
    // 与 handler 的 body 注入是同一对象。GET/HEAD 及空请求体（null，无 schema
    // 透传场景）恒 undefined
    if (body !== undefined && body !== null) {
      ctx.body = body;
    }

    // 5. 中间件按需加载（Vite 风格）：route.middlewares 为 undefined 时从 middlewarePaths 加载
    //    首次请求加载后缓存到 route 上，后续请求直接复用
    if (route.middlewares === undefined && route.injectors === undefined && route.middlewarePaths) {
      // dev 按需模式：先编译中间件源码（含依赖闭包）再 import
      await ensureMiddlewaresCompiled(route.middlewarePaths, rootDir);
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

    // 6. 注入器合并：全局注入器为基线，目录注入器覆盖同名。
    //    合并结果对固定 route 恒定（injectors 在上方第 5 步按需加载后就绪，
    //    reload 换新 route 记录），按 route WeakMap 缓存避免每请求 spread 重建
    let mergedInjectors = route.injectors;
    if (globalInjectors) {
      let merged = mergedInjectorsCache.get(route);
      if (!merged) {
        merged = { ...globalInjectors, ...route.injectors };
        mergedInjectorsCache.set(route, merged);
      }
      mergedInjectors = merged;
    }

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

  // 响应已发出，触发 onError 副作用（日志/告警/链路追踪）。钩子自身抛错 console.error
  // 留痕——不能影响已发出的响应（响应先于钩子发出），但静默吞掉会让业务方误以为
  // 告警/链路管道健康
  if (onError && ctx) {
    try {
      await onError(err, ctx);
    } catch (hookErr) {
      console.error('[faapi] lifecycle onError hook threw:', hookErr);
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
  registries?: AppRegistries,
  wsRoutes?: WsRouteManifest,
): Promise<void> {
  // meta/ctx 兜底：请求准备阶段抛错（如 content-length 超限的 413）时尚无 ctx
  let meta: ResponseMeta = { headers: {}, setCookies: [] };
  let ctx: FaapiContext | undefined;
  // SSE 提前接管标记：声明在 try 之外——catch 错误路径需读取（流已开始则不再发错误响应）
  let sseEarlySent = false;
  // 客户端断连信号：每请求一个 AbortController，signal 进入 Request（ctx.request.signal）
  // res 'close' 在响应正常完成（keep-alive）时也会触发，用 writableEnded 区分——
  // 响应未写完连接就断开（客户端提前断连）才 abort，正常完成不误触发
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });
  try {
    // 1. 路由匹配提前：在构造 ctx 之前完成（matchRoute 纯函数无副作用），
    //    命中则 params 原始段进入 ctx.params/ctx.rawParams——全局中间件
    //    await next() 之前即可读取；未命中传 null，404/405 仍由 routePipeline
    //    抛出（错误响应保持经过完整外层中间件链）
    const { request, url } = toWebRequest(req, bodyLimit, abortController.signal);
    const method = request.method.toUpperCase();
    const urlPath = url.pathname;
    const preMatched = matchRoute(routes, method, urlPath);

    // 2. 准备请求上下文（createContext）——Request/URL 由上方解析一次后传入
    const prepared = prepareRequest(
      req,
      request,
      url,
      config,
      trustedProxy,
      registries,
      preMatched,
    );
    ctx = prepared.ctx;
    meta = prepared.meta;

    // SSE 提前接管（详见 createServer.md「SSE 提前接管」）：ctx.sse() 首次写入
    // （send/sendRaw/sendError）触发本钩子，立即把 SSE Response 接入 res——流式
    // 期间字节即产即达，writer.aborted 也能实时感知客户端断开。early-sent 后
    // 正常/错误路径均不再发送响应
    (ctx as FaapiContext & { __earlyRespond?: (response: Response) => void }).__earlyRespond = (
      response: Response,
    ) => {
      if (sseEarlySent) return;
      sseEarlySent = true;
      // meta（含 CORS 头等）在首次写入时刻合并；此后的 setStatus/setHeader 不再生效。
      // fire-and-forget：接管完成在流关闭后，不阻塞 handler；管道错误按断连收尾
      void sendNodeResponse(mergeMeta(response, meta), res).catch(() => {
        if (!res.writableEnded) res.destroy();
      });
    };

    // 3. 创建路由执行管线（校验 + 中间件加载 + handler 调用）
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
      preMatched,
      wsRoutes,
    });

    // 4. 执行外层中间件链（CORS → helmet → logger → 全局 → routePipeline，
    //    数组已在 createServer 启动期组装，此处仅按需 compose）
    const response =
      outerMiddlewares.length > 0
        ? await compose(outerMiddlewares, ctx, routePipeline)
        : await routePipeline();
    // 5. 发送响应。SSE 已在首次写入时提前接管（响应在线上）：handler 返回值及
    //    中间件 await next() 之后替换的响应被忽略（日志等副作用仍正常执行）
    if (!sseEarlySent) {
      await sendSuccessResponse(response, res);
    }
  } catch (err: unknown) {
    // 客户端已断开或响应已完成：网络中断/连接销毁不是服务端错误，
    // 不向已销毁的连接写 500（写入无效），也不触发 onError 误报
    if (res.destroyed || res.writableEnded) return;
    // SSE 流已开始（响应头已发出）：无法再改发错误响应——流由 writer 关闭自然
    // 收尾（invokeHandler 的 autoClose 保证），仍触发 onError 副作用供告警观测
    if (sseEarlySent) {
      if (onError && ctx) {
        try {
          await onError(err, ctx);
        } catch {
          // onError 自身抛错不影响已发出的响应
        }
      }
      return;
    }
    // 413（请求体超限）：客户端可能仍在上传——响应附 Connection: close 并在写出
    // 后销毁请求连接。不关闭的话：请求体未消费，keep-alive 连接无法复用，客户端
    // 上传也只会收到晦涩的连接重置而非明确的 413
    if (err instanceof PayloadTooLargeError) {
      res.setHeader('Connection', 'close');
      res.once('finish', () => req.destroy());
    }
    await sendErrorResponse(err, meta, res, onError, ctx);
  }
}
