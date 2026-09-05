# 业务方测试 handler

何时使用：用户要测试 faapi handler / 中间件 / 注入器 / E2E 完整链路 / WebSocket 路由时。


### 快速反馈命令

改业务代码后无需每次全量跑（e2e 含服务器启动级用例，较慢）：

- `pnpm --filter @faapi/faapi run test:unit` — 只跑单元测试（排除 `*.e2e.test.ts`），秒级到十秒级
- `pnpm --filter @faapi/faapi run test:e2e` — 只跑端到端测试
- `pnpm --filter @faapi/faapi run test` — 全量（CI 与发布门禁跑的）

## 核心思路

faapi 的 handler 是"函数即接口"——按参数名自动注入 `query`/`body`/`ctx` 等依赖。框架分四层公开测试 API：

| 层次 | API | 启动 server | 依赖产物 | 走 schema | 走全局中间件 | 适用场景 |
|------|-----|-----------|---------|----------|------------|---------|
| 1. 直接调用 handler | 手动调用 | 否 | 否 | 否 | 否 | 纯逻辑 |
| 2. 轻量注入 | `createTestContext` + `invokeHandler` | 否 | 否 | 否 | 显式传入 | 注入/中间件/序列化 |
| 3. 完整链路注入 | `createProdApp` + `app.inject()` | 否 | ✅ | ✅ | ✅ | 完整链路（无端口） |
| 4. **E2E 真实端口** | **`createTestServer` + `fetch`** | **✅（listen 0）** | **自动生成** | **✅** | **✅（options.middlewares）** | **SSE/WS/CORS/真实 HTTP** |

## 公开 API

测试 API 通过 `@faapi/faapi/testing` 子路径导入，与主入口 `@faapi/faapi` 分离：

```ts
import {
  createTestContext,
  invokeHandler,
  createTestServer,
  connectWs,
  MessageQueue,
  waitForWsOpen,
  // 类型导出（按需 import）
  type TestServer,
  type TestServerOptions,
  type WsTestClient,
  type WsTestClientOptions,
  type CreateTestContextOptions,
} from '@faapi/faapi/testing';
```

### 轻量测试（不需启动服务器）

| 函数 | 说明 |
|------|------|
| `createTestContext(options)` | 测试入口：接受 `{ method?, path, query?, headers?, params?, config?, ip? }` 对象，免写 `new Request('http://localhost/...')` 的样板代码 |
| `invokeHandler(handler, ctx, body?, middlewares?, injectors?)` | 调用 handler，走注入 + 中间件 + 序列化，返回 Response |

`invokeHandler` 内部已调用 `toResponse` 将 handler 返回值转为 `Response`，业务方拿到的就是 `Response` 对象，可直接用 `res.status` / `await res.json()` 断言。

#### createTestContext 选项

```ts
const ctx = createTestContext({
  method: 'POST',                              // 默认 'GET'
  path: '/api/user',                            // 必填，无需写 host
  query: { page: 1, tags: ['a', 'b'] },        // 对象形式，自动拼接 URL（数组生成同名多值参数）
  headers: { authorization: 'Bearer xxx' },    // 请求头对象
  params: { id: '123' },                        // 动态路由参数，默认 {}
  config: { db: { host: '...' } },              // 业务配置，默认 {}
  ip: '1.2.3.4',                                // 客户端 IP，默认 ''
});
```

**body 不在 createTestContext 处理**：`createTestContext` 不读请求体，body 注入由 `invokeHandler` 第 3 参数负责。POST/PUT/PATCH 测试时 body 单独传给 `invokeHandler`，避免在两处传 body 产生混淆。

### E2E 测试（真实端口 + schema 校验）

| 函数 | 说明 |
|------|------|
| `createTestServer(options)` | 一键启动带 schema 校验的 E2E 测试服务器，返回 `TestServer` |
| `connectWs(baseUrl, pathname, options?)` | 一键连接 WS server，返回 `WsTestClient`（解决消息竞态 + 三事件监听 + 协议转换） |
| `MessageQueue` | WS 消息队列类（FIFO 缓冲 + Promise 化 `next()`） |
| `waitForWsOpen(ws, timeout?)` | Promise 化等待 WS `open` 事件（三事件监听 + 超时清理） |

`createTestServer` 内部自动：scanRoutes + sortRoutes + mkdtemp + generateSchemaFiles + createServer + listen(0)。
`ts.close()` 内部自动：closeAllConnections + closeIdleConnections + server.close + fs.rm(schemaDist) + invalidateSchemaCache。
业务方一行 setup、一行 teardown，代码聚焦断言。

> 注：`createTestServer` 不读 `faapi.config.ts`，全局中间件需通过 `options.middlewares` 显式传入（不同于 `createProdApp` 自动加载 config）。

## 测试模式选择

| 方式 | 适用场景 | 启动服务器 | 依赖产物 | 走注入 | 走中间件 | 走 schema |
|------|---------|-----------|---------|--------|---------|-----------|
| 直接调用 handler | 纯逻辑测试 | 否 | 否 | 否 | 否 | 否 |
| **`createTestContext` + `invokeHandler`** | **注入/中间件/序列化测试** | **否** | **否** | **✅** | **✅（显式传入）** | **否** |
| `createProdApp` + `app.inject()` | 完整链路（无端口） | 否 | ✅ | ✅ | ✅ | ✅ |
| **`createTestServer` + `fetch`** | **E2E（含 SSE/WS/CORS）** | **✅（listen 0）** | **自动生成** | **✅** | **✅** | **✅** |
| **`connectWs` + `queue.next()`** | **WS 路由测试** | — | — | — | — | — |

推荐分层：
- 纯逻辑 → 直接调用 handler
- 注入/中间件 → `createTestContext` + `invokeHandler`
- 完整链路（无端口、需 build 产物） → `createProdApp` + `app.inject`
- **E2E（SSE/WS/CORS/真实 HTTP） → `createTestServer` + `fetch`**
- **WS 路由 → `createTestServer` + `connectWs`**

## 示例

> 以下示例用 `createTestContext`（测试入口，接受选项对象，免写 `new Request`）。

### 1. 测试 GET handler（query 注入）

```ts
import { createTestContext, invokeHandler } from '@faapi/faapi/testing';
import { GET } from './handler';

it('GET 返回分页数据', async () => {
  const ctx = createTestContext({
    path: '/api/user',
    query: { page: 1, pageSize: 10 },  // 对象形式，无需拼 URL
    config: { db: { host: '...' } },
  });
  const res = await invokeHandler(GET, ctx);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ page: '1', pageSize: '10' });
});
```

> 注：测试时不走 schema 校验（zod.js 由 build 生成），`query.page` 为 string。如需测 coerce 后的 number 类型，走 E2E 测试。

### 2. 测试 POST handler（body 注入）

```ts
const ctx = createTestContext({ method: 'POST', path: '/api/user' });
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
  const ctx = createTestContext({
    path: '/api/admin',
    headers: { authorization: 'Bearer xxx' },
  });
  const res = await invokeHandler(GET, ctx, undefined, [authMiddleware], injectors);
  expect(res.status).toBe(200);
});

it('无 token 被拦截', async () => {
  const ctx = createTestContext({ path: '/api/admin' });
  const res = await invokeHandler(GET, ctx, undefined, [authMiddleware], injectors);
  expect(res.status).toBe(401);
});
```

### 4. 测试动态路由参数

```ts
const ctx = createTestContext({
  path: '/api/user/123',
  params: { id: '123' },
});
const res = await invokeHandler(GET, ctx);
expect(await res.json()).toEqual({ id: '123' });
```

### 5. 测试 ctx 便捷方法

```ts
const ctx = createTestContext({ path: '/api/error' });
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
| 不走 formatErrorResponse 兜底（handler 抛错会 re-throw，不会自动转 500 Response） | 显式传入错误处理中间件，或用 `createProdApp + app.inject` / `createTestServer` |
| SSE / 流式响应测试 | 测试 SSE 时用 E2E |
| 文件上传（files/fields） | 自行构造 `body = { files: [], fields: {} }` 传入 |

> 注：`invokeHandler` 定位为轻量单元测试入口，handler 抛错时会原样 re-throw（不走 `formatErrorResponse` 兜底，也不走 schema 校验）。原因：`invokeHandler` 接收的是 handler 函数本身而非 route 记录，无法定位 `zod.js`；测试时也未必 build 过。如需测试完整错误兜底链，用 E2E 测试或显式传入错误处理中间件。

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

### POST body 测试

`app.inject()` 支持 POST/PUT/PATCH 等带 body 的请求,`body` 参数会被序列化为 JSON 并自动设置 `content-type: application/json`:

```ts
const res = await app.inject({
  method: 'POST',
  path: '/api/user',
  body: { name: 'Alice', email: 'a@b.c' },
});
expect(res.status).toBe(200);
expect(res.body.created).toBe(true);  // body 已自动 JSON.parse
```

> 注:1.5.0 修复了 `app.inject()` 的 POST body 丢失 bug——旧版用 `PassThrough` 构造 mock 请求会丢失异步 body 流,现已改用 `Readable.from` 正确处理。升级到 1.5.0+ 后 POST/PUT/PATCH 的 body 注入才能正常工作。

### 在 Next.js RSC 中使用 getApp()

在拿不到 app 引用的场景(如 Next.js Server Component),用 `getApp()` 获取单例后调 `app.inject()` 同进程调用 faapi API,避免 HTTP loopback:

```ts
// src/app/page.tsx
import { getApp } from '@faapi/faapi';
import { headers } from 'next/headers';

async function Page() {
  const app = getApp();
  const h = await headers();
  const res = await app.inject({
    method: 'GET',
    path: '/api/user',
    headers: { cookie: h.get('cookie') ?? '' },
  });
  return <div>{res.body.name}</div>;
}
```

详见 [plugins.md](./plugins.md) 的"Next.js Server Component 同进程调用"章节。

## E2E 测试（真实端口 + 自动 schema）

如需测试 SSE / 流式响应 / WebSocket 路由 / CORS / 真实 HTTP 头，用 `createTestServer`：

```ts
import { createTestServer, type TestServer } from '@faapi/faapi/testing';

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
  dist: '/tmp/my-schema',       // 可选：schema 产物输出目录，不传时自动 mkdtemp
  bodyLimit: 10 * 1024 * 1024,  // 可选：请求体大小限制，默认 10MB
  // 以下可选，默认禁用 CORS/Helmet/Logger 避免污染断言
  cors: true,                    // 启用 CORS（反射 Origin）
  helmet: { ... },
  logger: { ... },
  middlewares: [authMiddleware], // 全局中间件（不读 faapi.config.ts，需显式传入）
  injectors: { db: () => mockDb },
  config: { db: { host: '...' } },
  onError: (err, ctx) => { ... },
});
```

`createTestServer` 返回的 `TestServer` 还包含 `schemaDist`（schema 临时目录绝对路径，可查看生成的 zod.js 用于调试）、`routes`/`wsRoutes`（排序后的路由清单，可在测试中断言路由表）字段。

### WebSocket 路由测试

```ts
import { createTestServer, connectWs } from '@faapi/faapi/testing';

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

### vitest 环境下的别名解析与 vi.mock

业务方 handler 用 TypeScript paths 别名（如 `import { db } from '@/lib/db'`）时，`createTestServer` 内部自动检测 `globalThis.vi.importActual`，走 Vite SSR pipeline：

- 识别 `vitest.config.ts` 的 `resolve.alias` 与 tsconfig paths 别名
- 让 `vi.mock('@/lib/db', ...)` 在加载的 handler 内生效

**前置**：`vitest.config.ts` 设 `test.globals: true`（推荐），或测试文件内显式 `import { vi } from 'vitest'` 后挂到 `globalThis.vi`。

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: { globals: true },
});
```

```ts
// src/e2e/test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestServer } from '@faapi/faapi/testing';

// vi.mock 顶层 hoist，createTestServer 内部加载的 handler 内可见
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, db: { ...actual.db, source: 'mocked' } };
});

let ts;
beforeAll(async () => { ts = await createTestServer({ rootDir: process.cwd() }); });
afterAll(() => ts.close());

it('vi.mock 生效：handler 看到 mocked 数据', async () => {
  const res = await fetch(`${ts.baseUrl}/api/user`);
  expect((await res.json()).source).toBe('mocked');
});
```

非 vitest 环境回退到 Node 原生 `import()`，无副作用。详见 `src/utils/importWithCacheBust.md`。

## 检查清单

- [ ] 测试文件使用 `.test.ts` 后缀，与 handler 同目录
- [ ] 纯逻辑测试直接调用 handler，不走框架
- [ ] 注入/中间件/序列化测试用 `createTestContext` + `invokeHandler`（免写 `new Request`）
- [ ] 完整链路测试用 `createProdApp` + `app.inject`（需 build 产物）
- [ ] handler 抛错测试用 `expect(...).rejects.toThrow()`（`invokeHandler` 会原样 re-throw，不走 `formatErrorResponse` 兜底，不能用 `res.status === 500` 断言）
- [ ] async handler 用 `await invokeHandler(...)`
