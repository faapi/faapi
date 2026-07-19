import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestServer, type TestServer } from './testServer';
import { connectWs } from './wsTestClient';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/api-basic');

/**
 * connectWs E2E 集成测试：搭配 createTestServer 测试真实 WS 路由
 *
 * 验证业务方可一行代码连接 WS server，免去手写"消息竞态防护 + 三事件监听"样板代码。
 */
let ts: TestServer;

beforeAll(async () => {
  ts = await createTestServer({
    rootDir: FIXTURES_DIR,
    patterns: ['api/**/*.ts'],
  });
});

afterAll(async () => {
  if (ts) await ts.close();
});

describe('connectWs 基础', () => {
  it('返回 WsTestClient 对象，含 ws/queue/close', async () => {
    const client = await connectWs(ts.baseUrl, '/api/chat');
    expect(client.ws).toBeDefined();
    expect(client.queue).toBeDefined();
    expect(typeof client.close).toBe('function');
    // 消费 onOpen 消息避免污染后续测试
    await client.queue.next(500);
    await client.close();
  });

  it('baseUrl 自动 http → ws 协议转换', async () => {
    // connectWs 内部把 http:// 换成 ws://
    const client = await connectWs(ts.baseUrl, '/api/chat');
    expect(client.ws.readyState).toBe(1); // OPEN
    await client.queue.next(500);
    await client.close();
  });
});

describe('WS 路由交互', () => {
  it('静态路由 /api/chat：onOpen 推送 connected', async () => {
    const { ws, queue, close } = await connectWs(ts.baseUrl, '/api/chat');
    const msg = await queue.next();
    expect(msg).toBe('connected');
    ws.close();
    await close();
  });

  it('onMessage echo：发消息后收到回显', async () => {
    const { ws, queue, close } = await connectWs(ts.baseUrl, '/api/chat');
    await queue.next(); // 消费 connected

    ws.send('hello');
    const echo = await queue.next();
    expect(echo).toBe('echo: hello');
    await close();
  });

  it('onMessage 多轮交互：连续发消息连续收到回显', async () => {
    const { ws, queue, close } = await connectWs(ts.baseUrl, '/api/chat');
    await queue.next();

    ws.send('msg1');
    const r1 = await queue.next();
    expect(r1).toBe('echo: msg1');

    ws.send('msg2');
    const r2 = await queue.next();
    expect(r2).toBe('echo: msg2');
    await close();
  });

  it('动态路由 /api/room/:id：提取参数并通过对象 send 回传', async () => {
    const { ws, queue, close } = await connectWs(ts.baseUrl, '/api/room/123');
    const msg = await queue.next();
    // onOpen 用对象 send，自动 JSON.stringify
    expect(JSON.parse(msg)).toEqual({ roomId: '123' });

    ws.send('hi');
    const echo = await queue.next();
    expect(echo).toBe('room 123: hi');
    await close();
  });

  it('query 参数不影响路由匹配', async () => {
    const { queue, close } = await connectWs(ts.baseUrl, '/api/chat?token=abc');
    const msg = await queue.next();
    expect(msg).toBe('connected');
    await close();
  });
});

describe('WS 握手中间件链', () => {
  it('中间件放行：握手完成，WS handler 收到中间件塞入的 ctx.user', async () => {
    const { queue, close } = await connectWs(ts.baseUrl, '/api/ws-auth', {
      headers: { authorization: 'Bearer test-token' },
    });

    const msg = await queue.next();
    expect(msg).toBe('hello alice');
    await close();
  });

  it('中间件拦截：无 token 返回 401，握手被拒绝、连接未建立', async () => {
    await expect(connectWs(ts.baseUrl, '/api/ws-auth')).rejects.toThrow();
  });

  it('父子中间件叠加：子级覆盖父级塞入的 ctx 值', async () => {
    const { queue, close } = await connectWs(ts.baseUrl, '/api/ws-chain/inner');
    const msg = await queue.next();
    expect(msg).toBe('tag:child');
    await close();
  });
});

describe('未匹配路径', () => {
  it('未匹配路径返回 404（连接被拒绝）', async () => {
    await expect(connectWs(ts.baseUrl, '/api/notfound')).rejects.toThrow();
  });
});

describe('WsTestClient.close', () => {
  it('close 等待 ws close 事件完成', async () => {
    const { ws, queue, close } = await connectWs(ts.baseUrl, '/api/chat');
    await queue.next();

    ws.close(1000, 'normal closure');
    // close 应在 ws close 事件触发后 resolve
    await expect(close()).resolves.toBeUndefined();
  });

  it('close 未先 ws.close() 时主动关闭', async () => {
    const { queue, close } = await connectWs(ts.baseUrl, '/api/chat');
    await queue.next();
    // 不调 ws.close()，直接 close()
    await expect(close()).resolves.toBeUndefined();
  });

  it('close 幂等：重复调用不抛错', async () => {
    const { queue, close } = await connectWs(ts.baseUrl, '/api/chat');
    await queue.next();
    await close();
    await expect(close()).resolves.toBeUndefined();
  });
});

describe('connectWs 超时与错误', () => {
  it('未连接路径超时后 reject', async () => {
    // 用一个未被监听的端口模拟连接失败
    await expect(connectWs('http://localhost:1', '/api/chat', { timeout: 100 })).rejects.toThrow();
  });

  it('自定义 timeout 影响 waitForWsOpen', async () => {
    // 连接不存在的端口，timeout=50 应快速 reject
    const start = Date.now();
    try {
      await connectWs('http://localhost:1', '/api/chat', { timeout: 50 });
    } catch {
      // 预期失败
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it('连接失败时不泄漏 CONNECTING 状态的 socket', async () => {
    // 验证方式：短时间内多次 connect 同一未监听端口，不应累积 socket 导致 ECONNREFUSED 之外的错误
    // 修复后 connectWs 失败时主动调 ws.close()，socket 会被立即释放
    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      await expect(connectWs('http://localhost:1', '/api/chat', { timeout: 80 })).rejects.toThrow();
    }
    const elapsed = Date.now() - start;
    // 5 次失败应在 5 * 80ms 超时 + 小幅开销内完成
    expect(elapsed).toBeLessThan(1000);
  });
});
