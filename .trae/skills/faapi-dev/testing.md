# 业务方测试 handler

何时使用：用户要测试 faapi handler / 中间件 / 注入器 / E2E 完整链路 / WebSocket 路由时。

## 核心思路

faapi 的 handler 是"函数即接口"——按参数名自动注入 `query`/`body`/`ctx` 等依赖。框架分四层公开测试 API：

| 层次 | API | 启动 server | 依赖产物 | 走 schema | 走全局中间件 | 适用场景 |
|------|-----|-----------|---------|----------|------------|---------|
| 1. 直接调用 handler | 手动调用 | 否 | 否 | 否 | 否 | 纯逻辑 |
| 2. 轻量注入 | `createContext` + `invokeHandler` | 否 | 否 | 否 | 显式传入 | 注入/中间件/序列化 |
| 3. 完整链路注入 | `createProdApp` + `app.inject()` | 否 | ✅ | ✅ | ✅ | 完整链路（无端口） |
| 4. **E2E 真实端口** | **`createTestServer` + `fetch`** | **✅（listen 0）** | **自动生成** | **✅** | **✅** | **SSE/WS/CORS/真实 HTTP** |

## 公开 API

```ts
import {
  createContext,
  invokeHandler,
  createTestServer,
  connectWs,
  MessageQueue,
  waitForWsOpen,
} from '@faapi/faapi';
```

### 轻量测试（不需启动服务器）

| 函数 | 说明 |
|------|------|
| `createContext(request, params, config?, ip?)` | 从 Web Request 创建 FaapiContext |
| `invokeHandler(handler, ctx, body?, middlewares?, injectors?)` | 调用 handler，走注入 + 中间件 + 序列化，返回 Response |

`invokeHandler` 内部已调用 `toResponse` 将 handler 返回值转为 `Response`，业务方拿到的就是 `Response` 对象，可直接用 `res.status` / `await res.json()` 断言。

### E2E 测试（真实端口 + schema 校验）

| 函数 | 说明 |
|------|------|
| `createTestServer(options)` | 一键启动带 schema 校验的 E2E 测试服务器，返回 `TestServer` |
| `connectWs(baseUrl, pathname, options?)` | 一键连接 WS server，返回 `WsTestClient`（解决消息竞态 + 三事件监听 + 协议转换） |
| `MessageQueue` | WS 消息队列类（FIFO 缓冲 + Promise 化 `next()`） |
| `waitForWsOpen(ws, timeout?)` | Promise 化等待 WS `open` 事件（三事件监听 + 超时清理） |

`createTestServer` 内部自动：scanRoutes + sortRoutes + mkdtemp + generateSchemaFiles + createServer + listen(0)。
`ts.close()` 内部自动：closeAllConnections + server.close + fs.rm(schemaDist) + invalidateSchemaCache。
业务方一行 setup、一行 teardown，代码聚焦断言。

## 测试模式选择

| 方式 | 适用场景 | 启动服务器 | 依赖产物 | 走注入 | 走中间件 | 走 schema |
|------|---------|-----------|---------|--------|---------|-----------|
| 直接调用 handler | 纯逻辑测试 | 否 | 否 | 否 | 否 | 否 |
| **`createContext` + `invokeHandler`** | **注入/中间件/序列化测试** | **否** | **否** | **✅** | **✅（显式传入）** | **否** |
| `createProdApp` + `app.inject()` | 完整链路（无端口） | 否 | ✅ | ✅ | ✅ | ✅ |
| **`createTestServer` + `fetch`** | **E2E（含 SSE/WS/CORS）** | **✅（listen 0）** | **自动生成** | **✅** | **✅** | **✅** |
| **`connectWs` + `queue.next()`** | **WS 路由测试** | — | — | — | — | — |

推荐分层：
- 纯逻辑 → 直接调用 handler
- 注入/中间件 → `createContext` + `invokeHandler`
- 完整链路（无端口、需 build 产物） → `createProdApp` + `app.inject`
- **E2E（SSE/WS/CORS/真实 HTTP） → `createTestServer` + `fetch`**
- **WS 路由 → `createTestServer` + `connectWs`**

## 示例

### 1. 测试 GET handler（query 注入）

```ts
import { createContext, invokeHandler } from '@faapi/faapi';
import { GET } from './handler';

it('GET 返回分页数据', async () => {
  const ctx = createContext(
    new Request('http://localhost/api/user?page=1&pageSize=10'),
    {},                      // params
    { db: { host: '...' } }, // config（业务配置）
  );
  const res = await invokeHandler(GET, ctx);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ page: '1', pageSize: '10' });
});
```

> 注：测试时不走 schema 校验（zod.js 由 build 生成），`query.page` 为 string。如需测 coerce 后的 number 类型，走 E2E 测试。

### 2. 测试 POST handler（body 注入）

```ts
const ctx = createContext(
  new Request('http://localhost/api/user', { method: 'POST' }),
  {},
);
const res = await invokeHandler(POST, ctx, { name: 'Alice', email: 'a@b.c' });
expect(await res.json()).toEqual({ created: true, name: 'Alice' });
```

### 3. 测试带中间件 + 注入器的 handler

```ts
import type { FaapiMiddleware, InjectorMap } from '@faapi/faapi';

const authMiddleware: FaapiMiddleware = async (ctx, next) => {
  if (!ctx.headers.get('authorization')) return new Response('Unauthorized', { status: 401 });
  ctx.user = { id: 1 };
  await next();
};

const injectors: InjectorMap = {
  user: (ctx) => (ctx as any).user,
  db: () => mockDb,
};

it('带鉴权通过', async () => {
  const ctx = createContext(
    new Request('http://localhost/api/admin', {
      headers: { authorization: 'Bearer xxx' },
    }),
    {},
  );
  const res = await invokeHandler(GET, ctx, undefined, [authMiddleware], injectors);
  expect(res.status).toBe(200);
});

it('无 token 被拦截', async () => {
  const ctx = createContext(new Request('http://localhost/api/admin'), {});
  const res = await invokeHandler(GET, ctx, undefined, [authMiddleware], injectors);
  expect(res.status).toBe(401);
});
```

### 4. 测试动态路由参数

```ts
const ctx = createContext(
  new Request('http://localhost/api/user/123'),
  { id: '123' },  // params
);
const res = await invokeHandler(GET, ctx);
expect(await res.json()).toEqual({ id: '123' });
```

### 5. 测试 ctx 便捷方法

```ts
const ctx = createContext(new Request('http://localhost/api/error'), {});
function handler(context: any) {
  return context.json({ error: 'Not found' }, 404);
}
const res = await invokeHandler(handler, ctx);
expect(res.status).toBe(404);
```

## 局限性

| 局限 | 替代方案 |
|------|----------|
| 不走 schema 校验（zod.js 由 build 生成） | 用 E2E 测试（`createProdApp` + `app.inject`） |
| 不走全局中间件（`faapi.config.ts` 配置的） | 显式传入中间件数组，或用 `createProdApp` 启动完整 app |
| SSE / 流式响应测试 | 测试 SSE 时用 E2E |
| 文件上传（files/fields） | 自行构造 `body = { files: [], fields: {} }` 传入 |

## 完整请求链路测试

如需测试完整请求链路（含 schema 校验、全局中间件、配置），用 `createProdApp` + `app.inject()`：

```ts
import { createProdApp } from '@faapi/faapi';

const app = await createProdApp({ rootDir: process.cwd() });
const res = await app.inject({ method: 'GET', path: '/api/hello' });
expect(res.status).toBe(200);
await app.close();
```

> 注：需先 `faapi build` 生成 `dist/` 产物。

## E2E 测试（真实端口 + 自动 schema）

如需测试 SSE / 流式响应 / WebSocket 路由 / CORS / 真实 HTTP 头，用 `createTestServer`：

```ts
import { createTestServer, type TestServer } from '@faapi/faapi';

let ts: TestServer;
beforeAll(async () => {
  ts = await createTestServer({ rootDir: process.cwd() });
});
afterAll(() => ts.close());

it('GET /api/user?page=1 → schema coerce 生效', async () => {
  const res = await fetch(`${ts.baseUrl}/api/user?page=1`);
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.page).toBe(1);  // schema coerce 后是 number
});
```

### 入参选项

```ts
createTestServer({
  rootDir: process.cwd(),       // 必填
  patterns: ['src/api/**/*.ts'], // 默认值
  // 以下可选，默认禁用 CORS/Helmet/Logger 避免污染断言
  cors: true,                    // 启用 CORS（反射 Origin）
  helmet: { ... },
  logger: { ... },
  middlewares: [authMiddleware], // 全局中间件
  injectors: { db: () => mockDb },
  config: { db: { host: '...' } },
  onError: (err, ctx) => { ... },
});
```

### WebSocket 路由测试

```ts
import { createTestServer, connectWs } from '@faapi/faapi';

let ts: TestServer;
beforeAll(async () => {
  ts = await createTestServer({ rootDir: process.cwd() });
});
afterAll(() => ts.close());

it('WS /api/chat 收到 onOpen 消息', async () => {
  const { ws, queue, close } = await connectWs(ts.baseUrl, '/api/chat');
  const msg = await queue.next();
  expect(msg).toBe('connected');
  await close();
});

it('WS 多轮交互', async () => {
  const { ws, queue, close } = await connectWs(ts.baseUrl, '/api/chat');
  await queue.next(); // 消费 connected

  ws.send('hello');
  const echo = await queue.next();
  expect(echo).toBe('echo: hello');
  await close();
});

it('WS 握手鉴权', async () => {
  const { queue, close } = await connectWs(ts.baseUrl, '/api/ws-auth', {
    headers: { authorization: 'Bearer test-token' },
  });
  const msg = await queue.next();
  expect(msg).toBe('hello alice');
  await close();
});

it('WS 无 token 被拦截', async () => {
  await expect(connectWs(ts.baseUrl, '/api/ws-auth')).rejects.toThrow();
});
```

`connectWs` 内部解决三个痛点：
1. 'open' 与 'message' 监听竞态（`MessageQueue` 在创建 ws 时立即开始缓冲）
2. 'error' / 'close' / 'open' 三事件监听 + 超时清理（`waitForWsOpen`）
3. `http://` → `ws://` 协议自动转换

### 何时用 createTestServer / 何时用 createProdApp

| 场景 | 推荐方式 |
|------|---------|
| 不需要真实 HTTP 端口的完整链路测试 | `createProdApp + app.inject`（需先 `faapi build`） |
| 需要 SSE / 流式响应 / 真实 HTTP 头 | `createTestServer + fetch` |
| 需要 WebSocket 路由测试 | `createTestServer + connectWs` |
| 需要读 `faapi.config.ts` / 加载插件 / 执行 lifecycle | `createProdApp` |
| 临时调试 / 单文件测试 | `createTestServer`（自动 schema，无需 build） |

### createTestServer 局限性

| 局限 | 替代方案 |
|------|---------|
| 不读 `faapi.config.ts`（仅用传入的 options） | `createProdApp`（需先 `faapi build`） |
| 不加载插件（`plugins` 字段） | `createProdApp` |
| 不执行 `lifecycle.onReady` / `onClose` | `createProdApp` |
| 无服务器 mock 注入（`app.inject`） | `createProdApp + app.inject` |

## 检查清单

- [ ] 测试文件使用 `.test.ts` 后缀，与 handler 同目录
- [ ] 纯逻辑测试直接调用 handler，不走框架
- [ ] 注入/中间件/序列化测试用 `createContext` + `invokeHandler`
- [ ] 完整链路测试用 `createProdApp` + `app.inject`（需 build 产物）
- [ ] handler 抛错测试用 `expect(...).rejects.toThrow()`
- [ ] async handler 用 `await invokeHandler(...)`
