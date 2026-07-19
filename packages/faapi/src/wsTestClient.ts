import { WebSocket, type RawData } from 'ws';

/**
 * WebSocket 测试客户端
 *
 * 公开导出 connectWs + MessageQueue + waitForWsOpen，业务方测试 WS 路由时
 * 免去手写"消息竞态防护 + 三事件监听 + 端口拼接"样板代码。
 *
 * 详见 src/wsTestClient.md。
 */

/**
 * connectWs 入参
 */
export interface WsTestClientOptions {
  /** 等待 open 的超时（ms），默认 2000 */
  timeout?: number;
  /** 握手请求头（如 authorization） */
  headers?: Record<string, string>;
  /** WS 子协议 */
  protocols?: string | string[];
}

/**
 * connectWs 返回值
 *
 * 业务方通过 ws.send() 发消息，queue.next() 取消息，close() 关闭。
 */
export interface WsTestClient {
  /** ws 库原生实例，业务方可直接 ws.send() / ws.close() */
  ws: WebSocket;
  /** 已开始缓冲的消息队列，调 next(timeout?) 取下一条 */
  queue: MessageQueue;
  /**
   * 关闭 ws 并等待 'close' 事件
   *
   * 内部：
   * 1. 若 ws 仍 OPEN/CLOSING，调 ws.close()
   * 2. 等待 'close' 事件（超时 1000ms 强制 resolve）
   *
   * 幂等：重复调用不抛错。
   */
  close(): Promise<void>;
}

/**
 * 消息队列：避免 once('message') 与服务端 onOpen 推送的竞态
 *
 * 服务端在 handleUpgrade 回调里同步触发 onOpen 并 send('connected')，
 * 客户端 'open' 事件触发后到注册 once('message') 之间存在窗口，
 * 若 'connected' 在此窗口内到达，once 会错过。
 *
 * 队列在创建 ws 时立即监听 'message'，按 FIFO 顺序消费。
 */
export class MessageQueue {
  private queue: string[] = [];
  private waiters: Array<(msg: string) => void> = [];
  private listener: (data: RawData) => void;

  constructor(ws: WebSocket) {
    this.listener = (data: RawData) => {
      const msg = normalizeRawData(data);
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(msg);
      } else {
        this.queue.push(msg);
      }
    };
    ws.on('message', this.listener);
  }

  /**
   * 取下一条消息
   *
   * 队列有则立即 resolve，无则注册 waiter 等待下一条 'message' 事件。
   * 超时未到 → reject('WebSocket message timeout')，waiter 被清理。
   *
   * @param timeout 超时毫秒，默认 2000
   */
  next(timeout = 2000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // 先定义 wrapped，再定义引用 wrapped 的 timer，避免 TDZ 风格可读性问题
      const wrapped = (msg: string) => {
        clearTimeout(timer);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(wrapped);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('WebSocket message timeout'));
      }, timeout);

      const msg = this.queue.shift();
      if (msg !== undefined) {
        wrapped(msg);
      } else {
        this.waiters.push(wrapped);
      }
    });
  }
}

/**
 * 将 ws 库的 RawData 统一转为 utf8 字符串
 *
 * RawData 可能形态：
 * - Buffer（最常见）
 * - Buffer[]（消息被分片，需先 concat）
 * - ArrayBuffer / ArrayBufferView（部分运行时）
 */
function normalizeRawData(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  // ArrayBuffer / ArrayBufferView
  return Buffer.from(data as unknown as Uint8Array).toString('utf8');
}

/**
 * Promise 化等待 ws 'open' 事件
 *
 * 同时监听 'open' / 'error' / 'close' 三事件，任一触发都清理 timer，
 * 避免 timer 泄漏。
 *
 * @param ws WebSocket 实例
 * @param timeout 超时毫秒，默认 2000
 * @returns 'open' → resolve；'error' → reject(err)；'close' → reject；超时 → reject
 */
export function waitForWsOpen(ws: WebSocket, timeout = 2000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('WebSocket open timeout'));
    }, timeout);

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeListener('open', onOpen);
      ws.removeListener('error', onError);
      ws.removeListener('close', onClose);
    };

    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket closed before open'));
    };

    ws.once('open', onOpen);
    ws.once('error', onError);
    ws.once('close', onClose);
  });
}

/**
 * 一键连接 WS server
 *
 * 内部流程：
 * 1. baseUrl 协议转换（http → ws，https → wss）
 * 2. new WebSocket(url, protocols, { headers })
 * 3. 立即创建 MessageQueue（开始缓冲消息，避免竞态）
 * 4. waitForWsOpen 等待连接建立（三事件监听 + 超时清理）
 * 5. 返回 WsTestClient
 *
 * 连接失败（中间件拦截 / 路径未匹配 / 超时）→ reject。
 *
 * @param baseUrl createTestServer().baseUrl（http://...）
 * @param pathname WS 路径，如 '/api/chat'，可含 query
 * @param options timeout / headers / protocols
 * @returns WsTestClient 实例
 */
export async function connectWs(
  baseUrl: string,
  pathname: string,
  options: WsTestClientOptions = {},
): Promise<WsTestClient> {
  const { timeout = 2000, headers, protocols } = options;

  // 协议转换：http → ws，https → wss（业务方传入 createTestServer().baseUrl）
  const wsBaseUrl = baseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const url = `${wsBaseUrl}${pathname}`;

  const ws = new WebSocket(url, protocols, headers ? { headers } : undefined);
  const queue = new MessageQueue(ws);

  // 等待 open；失败时主动 close ws，避免 socket 处于 CONNECTING 状态泄漏
  try {
    await waitForWsOpen(ws, timeout);
  } catch (err) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    throw err;
  }

  // 关闭状态标记（幂等保护）
  let closed = false;

  return {
    ws,
    queue,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;

      // 若 ws 仍 OPEN/CLOSING，主动 close
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }

      // 等待 'close' 事件（超时 1000ms 强制 resolve，避免 server 端不回 close）
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        ws.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
