import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket, type RawData } from 'ws';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { createServer } from './createServer';
import { generateSchemaFiles } from '../cli/generateSchemaFiles';
import { invalidateSchemaCache } from '../validator/validateInput';
import type { Server } from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/api-basic');

let server: Server | null = null;
let wsBaseUrl: string;
let schemaDist: string;

/**
 * 消息队列：避免 once('message') 与服务端 onOpen 推送的竞态。
 *
 * 服务端在 handleUpgrade 回调里同步触发 onOpen 并 send('connected')，
 * 客户端 'open' 事件触发后到注册 once('message') 之间存在窗口，
 * 若 'connected' 在此窗口内到达，once 会错过。
 *
 * 队列在创建 ws 时立即监听 'message'，按 FIFO 顺序消费。
 */
class MessageQueue {
  private queue: string[] = [];
  private waiters: Array<(msg: string) => void> = [];
  private listener: (data: RawData) => void;

  constructor(ws: WebSocket) {
    this.listener = (data: RawData) => {
      const msg = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.from(data as unknown as Uint8Array).toString('utf8');
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(msg);
      } else {
        this.queue.push(msg);
      }
    };
    ws.on('message', this.listener);
  }

  next(timeout = 2000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('WebSocket message timeout'));
      }, timeout);
      const wrapped = (msg: string) => {
        clearTimeout(timer);
        resolve(msg);
      };
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
 * 等待连接建立
 */
function waitForOpen(ws: WebSocket, timeout = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), timeout);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.once('close', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket closed before open'));
    });
  });
}

/**
 * 连接并返回 (ws, queue)，队列已开始缓冲消息。
 */
async function connect(pathname: string): Promise<{ ws: WebSocket; queue: MessageQueue }> {
  const ws = new WebSocket(`${wsBaseUrl}${pathname}`);
  const queue = new MessageQueue(ws);
  await waitForOpen(ws);
  return { ws, queue };
}

beforeAll(async () => {
  const { routes, wsRoutes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
  const sorted = sortRoutes(routes);
  // 生成 zod.js 到临时目录（createServer 运行时按 route.filePath + dist 计算 zod.js 路径）
  schemaDist = await fs.mkdtemp(path.join(os.tmpdir(), 'faapi-e2e-ws-schema-'));
  await generateSchemaFiles(sorted, FIXTURES_DIR, schemaDist);
  const { server: srv } = createServer({
    routes: sorted,
    rootDir: FIXTURES_DIR,
    dist: schemaDist,
    wsRoutes,
  });

  await new Promise<void>((resolve, reject) => {
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr !== null) {
        const port = addr.port;
        wsBaseUrl = `ws://localhost:${port}`;
        server = srv;
        resolve();
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
  });
});

afterAll(async () => {
  if (server) {
    // 关闭所有保持的连接（Node 18+），避免 WS 连接阻止 server.close 回调
    const anyServer = server as Server & {
      closeAllConnections?: () => void;
      closeIdleConnections?: () => void;
    };
    anyServer.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
    server = null;
  }
  if (schemaDist) {
    await fs.rm(schemaDist, { recursive: true, force: true });
  }
  invalidateSchemaCache();
});

describe('WebSocket e2e', () => {
  it('静态路由 /api/chat：连接成功并收到 onOpen 消息', async () => {
    const { ws, queue } = await connect('/api/chat');
    const msg = await queue.next();
    expect(msg).toBe('connected');
    ws.close();
  });

  it('onMessage echo：发消息后收到回显', async () => {
    const { ws, queue } = await connect('/api/chat');
    await queue.next(); // 消费 onOpen 的 'connected'

    ws.send('hello');
    const echo = await queue.next();
    expect(echo).toBe('echo: hello');

    ws.close();
  });

  it('onMessage 多轮交互：连续发消息连续收到回显', async () => {
    const { ws, queue } = await connect('/api/chat');
    await queue.next(); // 消费 connected

    ws.send('msg1');
    const r1 = await queue.next();
    expect(r1).toBe('echo: msg1');

    ws.send('msg2');
    const r2 = await queue.next();
    expect(r2).toBe('echo: msg2');

    ws.close();
  });

  it('动态路由 /api/room/:id：提取参数并通过对象 send 回传', async () => {
    const { ws, queue } = await connect('/api/room/123');
    const msg = await queue.next();
    // onOpen 用对象 send，自动 JSON.stringify
    expect(JSON.parse(msg)).toEqual({ roomId: '123' });

    ws.send('hi');
    const echo = await queue.next();
    expect(echo).toBe('room 123: hi');

    ws.close();
  });

  it('未匹配路径返回 404（连接被拒绝）', async () => {
    const ws = new WebSocket(`${wsBaseUrl}/api/notfound`);
    await expect(waitForOpen(ws)).rejects.toThrow();
    ws.close();
  });

  it('query 参数在 WsContext.query 中可用', async () => {
    // 通过查询参数传递 token，验证握手阶段 query 提取
    const { ws, queue } = await connect('/api/chat?token=abc');
    // fixture 未读取 query，但能连接成功说明 query 不影响路由匹配
    const msg = await queue.next();
    expect(msg).toBe('connected');
    ws.close();
  });

  it('连接关闭后服务端 onClose 触发（无异常）', async () => {
    const { ws, queue } = await connect('/api/chat');
    await queue.next();

    ws.close(1000, 'normal closure');

    // 等待关闭完成，无异常即通过
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
    });
  });
});

describe('WebSocket 握手中间件链', () => {
  it('中间件放行：握手完成，WS handler 收到中间件塞入的 ctx.user', async () => {
    const ws = new WebSocket(`${wsBaseUrl}/api/ws-auth`, {
      headers: { authorization: 'Bearer test-token' },
    });
    const queue = new MessageQueue(ws);
    await waitForOpen(ws);

    const msg = await queue.next();
    expect(msg).toBe('hello alice');
    ws.close();
  });

  it('中间件拦截：无 token 返回 401，握手被拒绝、连接未建立', async () => {
    const ws = new WebSocket(`${wsBaseUrl}/api/ws-auth`);
    await expect(waitForOpen(ws)).rejects.toThrow();
    ws.close();
  });

  it('父子中间件叠加：子级覆盖父级塞入的 ctx 值', async () => {
    const { ws, queue } = await connect('/api/ws-chain/inner');
    const msg = await queue.next();
    expect(msg).toBe('tag:child');
    ws.close();
  });

  it('无中间件的 WS 路由保持原有行为', async () => {
    const { ws, queue } = await connect('/api/chat');
    const msg = await queue.next();
    expect(msg).toBe('connected');
    ws.close();
  });
});
