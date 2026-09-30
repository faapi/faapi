/**
 * WebSocket Handler 类型定义与 socket 封装
 *
 * 用户在 handler.ts 中导出 WS 函数，返回事件回调对象。
 * 框架在协议升级成功后调用对应回调，传递封装后的 WsSocket。
 *
 * @see wsHandler.md 功能说明
 */

import { stringifyJson } from '../utils/stringifyJson';

/**
 * faapi 封装的 WebSocket socket 抽象
 *
 * 不直接暴露 ws 库的原生 socket，提供更安全、易用的 API。
 * send 对象时自动 JSON.stringify。
 */
export interface WsSocket {
  /** 发送数据（string/Buffer 直发，对象自动 JSON.stringify） */
  send(data: string | Buffer | object): void;
  /** 关闭连接 */
  close(code?: number, reason?: string | Buffer): void;
  /** 连接状态：0=connecting, 1=open, 2=closing, 3=closed */
  readonly readyState: number;
}

/**
 * WebSocket 事件回调集合
 *
 * 用户在 WS handler 中返回此对象，框架在对应事件触发时调用。
 * 所有回调可选，未提供则忽略事件。
 */
export interface WsEventHandlers {
  /** 连接建立时触发 */
  onOpen?: (ws: WsSocket) => void;
  /** 收到客户端消息时触发 */
  onMessage?: (ws: WsSocket, message: string | Buffer) => void;
  /** 连接关闭时触发 */
  onClose?: (ws: WsSocket, code: number, reason: string) => void;
  /** 发生错误时触发 */
  onError?: (ws: WsSocket, error: Error) => void;
}

/**
 * WebSocket 上下文（握手阶段构造）
 *
 * 与 HTTP FaapiContext 类似但精简，提供路由参数、查询参数、请求头、配置。
 * 可通过 declare module '@faapi/faapi' 增强自定义字段。
 *
 * 输入口径与 HTTP 一致（二分）：params/query 为校验转换后的值，rawParams/rawQuery
 * 恒为原始值。声明来源是 handler.ts 的文件级约定——导出 `WS` 且同文件声明
 * `export interface Query` / `export interface Params` 时，握手阶段按声明类型
 * 校验并转换（失败拒绝握手）；未声明时 params/query 保持 URL 原始字符串。
 */
export interface WsContext {
  /** 动态路由参数（声明 Params 时校验转换，未声明为 URL 原始字符串） */
  params: Record<string, string | number | boolean>;
  /** 动态路由参数的原始值（恒 URL 字符串，校验不触及） */
  rawParams: Record<string, string>;
  /** URL 查询参数（声明 Query 时校验转换，未声明为原始字符串对象） */
  query: Record<string, unknown>;
  /** URL 查询参数的原始值（恒 URLSearchParams） */
  rawQuery: URLSearchParams;
  /** 请求头 */
  headers: Headers;
  /** 业务配置（来自 faapi.config.ts） */
  config: Record<string, unknown>;
  /**
   * 运行时资源根目录绝对路径（<rootDir>/<dist>/resources）
   *
   * 与 HTTP FaapiContext 同源（握手 ctx 是 FaapiContext 的结构子集），handler
   * 的 WS 回调里读静态文件用。testing 直调未传时为 undefined。
   */
  resourcesDir?: string;
  /** 中间件塞入的用户信息（鉴权等） */
  user?: unknown;
  /** 允许通过 declare module 扩展 */
  [key: string]: unknown;
}

/**
 * WS handler 签名：接收 WsContext，返回事件回调对象（或无返回）
 */
export type WsHandler = (ctx: WsContext) => WsEventHandlers | void;

/**
 * 将 ws 库的原生 WebSocket 封装为 faapi 的 WsSocket
 *
 * - send 对象时自动 JSON.stringify
 * - close/re.readyState 透传原生 socket
 */
export function wrapWsSocket(rawSocket: {
  send: (data: string | Buffer, cb?: (err?: Error) => void) => void;
  close: (code?: number, reason?: string | Buffer) => void;
  readonly readyState: number;
}): WsSocket {
  return {
    send(data: string | Buffer | object): void {
      // BigInt 安全序列化（含 BigInt 的对象 send 不再抛错），见 utils/stringifyJson
      const payload =
        typeof data === 'string' || Buffer.isBuffer(data) ? data : stringifyJson(data);
      rawSocket.send(payload);
    },
    close(code?: number, reason?: string | Buffer): void {
      rawSocket.close(code, reason);
    },
    get readyState(): number {
      return rawSocket.readyState;
    },
  };
}
