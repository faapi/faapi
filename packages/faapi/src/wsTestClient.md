# wsTestClient

一句话概括：公开导出 `connectWs` + `MessageQueue` + `waitForWsOpen`，业务方测试 WebSocket 路由时免去手写"消息竞态防护 + 三事件监听 + 端口拼接"的样板代码。

## 为什么需要

业务方测试 WebSocket 路由时，直接用 `ws` 库 `new WebSocket(url)` 会遇到三个痛点：

1. **'open' 与 'message' 监听竞态**：服务端在 `handleUpgrade` 回调里同步触发 `onOpen` 并 `send('connected')`，客户端 `'open'` 事件触发后到注册 `once('message')` 之间存在窗口，若 'connected' 在此窗口内到达，`once` 会错过。
2. **超时未清理导致泄漏**：`waitForOpen` 只监听 `open` 事件，连接失败时 timer 永远不清理，测试进程挂起。
3. **WS 连接阻止 server.close 回调**：`server.close()` 在 WS 连接保持时永远不会触发回调，必须用 `closeAllConnections?.()`（Node 18+）强制断开——但这是 `testServer.close()` 的责任，本模块只负责客户端。

`connectWs` 一行完成"创建 ws + 注册队列 + 等待 open"，`queue.next()` Promise 化取消息，业务方代码聚焦断言。

## 使用场景

- 测试 WS 路由的 `onOpen` 推送消息
- 测试 WS 路由的 `onMessage` echo / 多轮交互
- 测试 WS 动态路由（`[id]`）参数提取
- 测试 WS 握手中间件链（鉴权 / 父子叠加）
- 测试 WS 关闭码与原因

## 公开 API

```ts
import {
  connectWs,
  MessageQueue,
  waitForWsOpen,
  type WsTestClient,
  type WsTestClientOptions,
} from '@faapi/faapi';
```

| 符号 | 说明 |
|------|------|
| `connectWs(baseUrl, pathname, options?)` | 一键连接 WS server，返回 `WsTestClient` |
| `MessageQueue` | 消息队列类（FIFO 缓冲 + Promise 化取消息） |
| `waitForWsOpen(ws, timeout?)` | Promise 化等待 `open`，含三事件监听与超时清理 |
| `WsTestClient` | 返回类型：含 `ws`/`queue`/`close()` |
| `WsTestClientOptions` | 入参类型：`timeout`/`headers`/`protocols` |

### `connectWs(baseUrl, pathname, options?)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `baseUrl` | `string` | `createTestServer().baseUrl`（如 `http://localhost:54321`），自动转 `ws://` |
| `pathname` | `string` | WS 路径（如 `/api/chat`），可含 query（如 `/api/chat?token=abc`） |
| `options.timeout` | `number` | 等待 open 的超时（ms），默认 `2000` |
| `options.headers` | `Record<string, string>` | 握手请求头（如 `authorization`） |
| `options.protocols` | `string \| string[]` | WS 子协议 |

返回 `WsTestClient`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ws` | `WebSocket` | `ws` 库原生实例，业务方可直接 `ws.send()` / `ws.close()` |
| `queue` | `MessageQueue` | 已开始缓冲的消息队列，调 `next(timeout?)` 取下一条 |
| `close()` | `() => Promise<void>` | 关闭 ws 并等待 'close' 事件，超时 1000ms 强制 resolve |

### `MessageQueue`

```ts
class MessageQueue {
  constructor(ws: WebSocket);
  next(timeout?: number): Promise<string>;  // 默认 2000ms 超时
}
```

行为：

- 构造时立即在 ws 上注册 `'message'` 监听器，按 FIFO 顺序缓冲
- `next()` 取下一条消息：队列有则立即 resolve，无则注册 waiter 等待下一条 `'message'` 事件
- 超时拒绝（`WebSocket message timeout`），清理 waiter
- 消息统一转 `string`（`Buffer.isBuffer` → `toString('utf8')`，其他 → `Buffer.from(...).toString('utf8')`）

### `waitForWsOpen(ws, timeout?)`

```ts
function waitForWsOpen(ws: WebSocket, timeout?: number): Promise<void>;
```

行为：

- 同时监听 `'open'` / `'error'` / `'close'` 三事件
- `'open'` → resolve
- `'error'` → reject(err)
- `'close'` → reject(new Error('WebSocket closed before open'))
- 超时 → reject(new Error('WebSocket open timeout'))
- 任一事件触发都 `clearTimeout`，避免 timer 泄漏

## 示例

### 1. 基础 WS 测试（搭配 `createTestServer`）

```ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createTestServer, connectWs, type TestServer } from '@faapi/faapi';

let ts: TestServer;
beforeAll(async () => {
  ts = await createTestServer({ rootDir: process.cwd() });
});
afterAll(() => ts.close());

describe('chat WS', () => {
  it('连接后收到 onOpen 推送', async () => {
    const { ws, queue } = await connectWs(ts.baseUrl, '/api/chat');
    const msg = await queue.next();
    expect(msg).toBe('connected');
    ws.close();
  });

  it('echo 多轮交互', async () => {
    const { ws, queue } = await connectWs(ts.baseUrl, '/api/chat');
    await queue.next(); // 消费 connected

    ws.send('hello');
    const r1 = await queue.next();
    expect(r1).toBe('echo: hello');

    ws.send('world');
    const r2 = await queue.next();
    expect(r2).toBe('echo: world');

    ws.close();
  });
});
```

### 2. 测试动态路由参数

```ts
it('WS /api/room/123 提取 id', async () => {
  const { ws, queue } = await connectWs(ts.baseUrl, '/api/room/123');
  const msg = await queue.next();
  expect(JSON.parse(msg)).toEqual({ roomId: '123' });
  ws.close();
});
```

### 3. 测试握手鉴权

```ts
it('带 token 握手成功', async () => {
  const { ws, queue } = await connectWs(ts.baseUrl, '/api/ws-auth', {
    headers: { authorization: 'Bearer test-token' },
  });
  const msg = await queue.next();
  expect(msg).toBe('hello alice');
  ws.close();
});

it('无 token 握手被拒', async () => {
  await expect(connectWs(ts.baseUrl, '/api/ws-auth')).rejects.toThrow();
});
```

### 4. 测试关闭码

```ts
it('客户端主动关闭', async () => {
  const { ws, close } = await connectWs(ts.baseUrl, '/api/chat');
  await queue.next();
  ws.close(1000, 'normal closure');
  await close(); // 等待 'close' 事件
});
```

### 5. 单独使用 `MessageQueue`（已自己持有 ws）

```ts
import { MessageQueue, waitForWsOpen } from '@faapi/faapi';
import { WebSocket } from 'ws';

const ws = new WebSocket(`ws://localhost:54321/api/chat`);
const queue = new MessageQueue(ws);
await waitForWsOpen(ws);
const msg = await queue.next();
ws.close();
```

## 与 `createTestServer` 的协作

`connectWs` 接收 `createTestServer().baseUrl`（`http://`）作为入参，内部自动转 `ws://`：

```ts
const wsBaseUrl = baseUrl.replace(/^http:/, 'ws:');
```

业务方无需手动拼接协议头。

`createTestServer.close()` 内部调用 `server.closeAllConnections?.()` 强制断开 WS 连接，`afterAll` 中先 `ws.close()` 再 `ts.close()` 即可避免连接泄漏。

## 局限性

| 局限 | 替代方案 |
|------|---------|
| 仅支持文本消息（`next()` 返回 `string`） | 业务方直接用 `ws.on('message', cb)` 处理二进制 |
| 不支持 WSS（加密 WS） | 业务方自行 `new WebSocket('wss://...')` + `MessageQueue` |
| 不模拟客户端事件回调（onClose/onError） | 业务方直接 `ws.on('close', cb)` / `ws.on('error', cb)` |

## 相关模块

- [testServer.ts](./testServer.ts) - `createTestServer` 启动测试 server，提供 `baseUrl`
- [runtime/wsHandler.ts](./runtime/wsHandler.ts) - 框架 WS handler 实现（`WsContext`/`WsSocket`/`WsEventHandlers`）
- [server/handleWsUpgrade.ts](./server/handleWsUpgrade.ts) - WS 升级握手（中间件链）
- [testing.md](./testing.md) - 业务方测试支持总览
