/**
 * WebSocket 协议升级处理
 *
 * 监听 HTTP server 的 upgrade 事件，匹配 WS 路由后调用 ws 库完成协议升级，
 * 加载 handler.ts 的 WS 导出，绑定事件回调。
 *
 * 握手阶段复用洋葱中间件链（鉴权/CORS/限流/日志等），与同目录 HTTP 路由共享中间件。
 * 中间件塞入 ctx 的值（如 ctx.user）传入 WS handler。连接建立后切到事件模型，不走中间件。
 *
 * @see wsHandler.md WS handler 约定与握手中间件链设计
 */
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import type { WsRouteMatch, RoutesRef } from '../router/routeTypes';
import { matchWsRoute } from '../router/matchRoute';
import { createContext } from '../runtime/createContext';
import { compose, mergeMeta } from '../runtime/invokeHandler';
import type { FaapiContext, ResponseMeta } from '../runtime/contextTypes';
import type { FaapiMiddleware } from '../middleware/middlewareTypes';
import type { InjectorMap } from '../middleware/injectorTypes';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import { getClientIp } from '../utils/getClientIp';
import { nodeHttpToWebHeaders, buildErrorResponse } from './serverUtils';
import type { ErrorFormatFn } from '../config/configTypes';
import {
  wrapWsSocket,
  type WsContext,
  type WsEventHandlers,
  type WsHandler,
} from '../runtime/wsHandler';

/**
 * 从 IncomingMessage 提取 URL pathname（不含 query）
 */
function getPathname(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const idx = url.indexOf('?');
  return idx >= 0 ? url.slice(0, idx) : url;
}

/**
 * 加载 WS handler 并执行，返回事件回调对象（可能为空）
 *
 * 直接动态 import handler.ts 并取 `WS` 导出（不经过 loadRouteModule，
 * 因为 WS 不是 HTTP 方法，loadRouteModule 的 method 维度不适用）。
 * watch 模式下通过时间戳 query string 绕过 ESM 缓存。
 */
async function loadWsHandler(filePath: string, ctx: WsContext): Promise<WsEventHandlers | void> {
  const module = await importWithCacheBust(filePath);
  const handler = module['WS'];
  if (typeof handler !== 'function') {
    throw new Error(`WS export not found in ${filePath}`);
  }
  return (handler as WsHandler)(ctx);
}

/**
 * 绑定 ws 库原生事件到 faapi 的 WsEventHandlers
 *
 * 注意：wss.handleUpgrade 回调触发时 socket 已经处于 OPEN 状态，
 * 'open' 事件不会再触发，需要直接同步调用 onOpen。
 */
function bindEvents(rawSocket: WebSocket, handlers: WsEventHandlers | void): void {
  if (!handlers) return;
  const ws = wrapWsSocket(rawSocket);

  if (handlers.onOpen) {
    // handleUpgrade 回调触发时 socket 已是 OPEN，直接同步调用
    if (rawSocket.readyState === WebSocket.OPEN) {
      handlers.onOpen!(ws);
    } else {
      rawSocket.once('open', () => handlers.onOpen!(ws));
    }
  }
  if (handlers.onMessage) {
    rawSocket.on('message', (data: Buffer) => {
      // ws 库 message 事件传 Buffer[]，合并为单个 Buffer 后转 string
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as Uint8Array);
      handlers.onMessage!(ws, buf.toString('utf8'));
    });
  }
  if (handlers.onClose) {
    rawSocket.on('close', (code: number, reason: Buffer) => {
      handlers.onClose!(ws, code, reason.toString('utf8'));
    });
  }
  if (handlers.onError) {
    rawSocket.on('error', (err: Error) => {
      handlers.onError!(ws, err);
    });
  }
}

/**
 * 把 Web Response 写回原始 socket（握手被中间件拦截或出错时使用）
 *
 * socket 未升级为 WebSocket 时，按 HTTP 响应格式写回并销毁。
 */
async function sendResponseToSocket(socket: Socket, response: Response): Promise<void> {
  const body = await response.text().catch(() => '');
  const statusLine = `HTTP/1.1 ${response.status} ${response.statusText || ''}\r\n`;
  const headerLines: string[] = [];
  let hasContentLength = false;
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === 'content-length') {
      hasContentLength = true;
    }
    headerLines.push(`${key}: ${value}`);
  }
  if (!hasContentLength) {
    headerLines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  }
  socket.write(statusLine + headerLines.join('\r\n') + '\r\n\r\n' + body);
  socket.destroy();
}

export interface AttachWsOptions {
  /** HTTP server 实例（已由 createServer 创建） */
  server: Server;
  /** 路由可变引用容器（watch 模式热替换时 routesRef.wsCurrent 被更新） */
  routesRef: RoutesRef;
  /** 项目根目录，用于解析路由文件绝对路径 */
  rootDir: string;
  /** 业务配置，注入到 WsContext.config */
  config?: Record<string, unknown>;
  /** 错误响应格式化函数（来自 faapi.config.ts） */
  errorFormat?: ErrorFormatFn;
  /** 全局中间件（来自 faapi.config.ts，WS 握手最外层） */
  globalMiddlewares?: FaapiMiddleware[];
  /** 全局注入器（来自 faapi.config.ts，WS handler 可通过 ctx 间接访问全局依赖） */
  globalInjectors?: InjectorMap;
}

/**
 * 在 HTTP server 上挂载 WebSocket 升级处理
 *
 * 创建独立的 WebSocketServer（noServer 模式），监听 server 的 upgrade 事件。
 * 路由匹配成功后，走洋葱中间件链：
 * - 中间件放行（await next）：finalHandler 内调用 ws.handleUpgrade 完成协议升级、绑定事件回调
 * - 中间件拦截（返回 Response）：把 Response 写回 socket 后销毁，不进行协议升级
 * - 中间件抛错：由 errorFormat/内置兜底生成错误 Response，写回 socket 后销毁
 *
 * 中间件链顺序：全局中间件（外）→ 目录中间件（内）→ finalHandler。
 * watch 模式下 wsRoutes 通过 routesRef 引用更新。
 */
export function attachWebSocket(options: AttachWsOptions): WebSocketServer {
  const { server, routesRef, rootDir, config, errorFormat, globalMiddlewares } = options;

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const currentWsRoutes = routesRef.wsCurrent;
    const pathname = getPathname(req);
    const match: WsRouteMatch | null = matchWsRoute(currentWsRoutes, pathname);

    if (!match) {
      // 路由不匹配：返回 404 并销毁 socket
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const { route, params } = match;
    const headers = nodeHttpToWebHeaders(req);
    const host = req.headers.host ?? 'localhost';
    const url = `http://${host}${req.url ?? '/'}`;

    // 构造 Web Request 与 FaapiContext（与 HTTP 请求一致，供中间件使用）
    const request = new Request(url, { method: 'GET', headers });
    const ctx = createContext(request, params, config, getClientIp(req));
    const meta = (ctx as FaapiContext & { meta: ResponseMeta }).meta;

    // 标记握手是否已完成协议升级（用于判断 socket 是否可写）
    let upgraded = false;

    // finalHandler：加载 WS handler + 协议升级 + 绑定事件
    const finalHandler = async (): Promise<Response> => {
      let handlers: WsEventHandlers | void;
      try {
        const absoluteFilePath = path.resolve(rootDir, route.filePath);
        // WsContext 是 FaapiContext 的结构子集，直接复用 ctx 实例
        // 中间件塞入的字段（如 ctx.user）对 WS handler 可见
        handlers = await loadWsHandler(absoluteFilePath, ctx as unknown as WsContext);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[faapi] WS handler 加载失败 ${route.filePath}: ${reason}`);
        return new Response('Internal Server Error', { status: 500 });
      }

      // 协议升级：等 wss.handleUpgrade 回调完成 bindEvents
      await new Promise<void>((resolve, reject) => {
        wss.handleUpgrade(req, socket, head, (rawSocket: WebSocket) => {
          try {
            bindEvents(rawSocket, handlers);
            wss.emit('connection', rawSocket, req);
            upgraded = true;
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });

      // 占位 Response，表示握手成功（socket 已升级，不会被写出）
      return new Response(null, { status: 200 });
    };

    // 执行中间件链：全局中间件（外）+ 目录中间件（内）
    let response: Response;
    try {
      const dirMiddlewares = route.middlewares ?? [];
      const allMiddlewares =
        globalMiddlewares && globalMiddlewares.length > 0
          ? [...globalMiddlewares, ...dirMiddlewares]
          : dirMiddlewares;
      if (allMiddlewares.length > 0) {
        response = await compose(allMiddlewares, ctx, finalHandler);
      } else {
        response = await finalHandler();
      }
    } catch (err) {
      if (upgraded) {
        // 握手已完成（socket 已被 ws 库接管），中间件 after 阶段抛错无法改写响应
        console.error('[faapi] WS 握手后中间件抛错:', err);
        return;
      }
      // 错误兜底链：errorFormat 返回 null/未处理或抛错 → 内置 formatErrorResponse 兜底
      response = buildErrorResponse(err, ctx, errorFormat);
    }

    // 握手成功：socket 已升级，中间件 after 阶段已执行完，无需再写
    if (upgraded) {
      return;
    }

    // 中间件拦截或错误：把 Response 写回 socket 后销毁
    await sendResponseToSocket(socket, mergeMeta(response, meta));
  });

  return wss;
}
