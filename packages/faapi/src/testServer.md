# testServer

一句话概括：公开导出 `createTestServer`，业务方一键启动带 schema 校验的 E2E 测试服务器（`listen(0)` 随机端口），返回 `baseUrl` 与 `close`，免去手写"扫描路由 + 生成 zod.js + 监听端口 + 清理缓存"的样板代码。

## 为什么需要

业务方做 E2E 测试时（测试完整请求链路：含 schema 校验、全局中间件、配置、CORS、错误兜底），如果不封装 helper，每个测试文件都要重复写：

1. `scanRoutes` 扫描 fixture 路由
2. `sortRoutes` 排序
3. `mkdtemp` 创建临时 schema 目录
4. `generateSchemaFiles` 生成 `zod.js`
5. `createServer` 创建 server（手动传 routes/rootDir/dist/cors/middlewares 等）
6. `srv.listen(0)` 随机端口
7. `srv.address()` 取真实端口
8. `afterAll` 中 `closeAllConnections?.()` + `srv.close()` + `fs.rm(schemaDist)` + `invalidateSchemaCache()`

这些步骤在框架自身的 6 个 E2E 测试文件中各复刻一份，业务方复制成本高、易错（漏掉 `invalidateSchemaCache` 会导致测试串扰）。

通过公开 `createTestServer`，业务方一行代码完成 setup，`close()` 一行完成 teardown，覆盖 80% E2E 测试场景。剩余场景（自定义 createServer 选项、HTTP/2、需要读 config 的全链路）可降级到 `createProdApp + app.inject` 或直接组合底层 API。

## 使用场景

- 业务方 E2E 测试：测完整请求链路（schema 校验 + 中间件 + 序列化）
- 测试 WebSocket 路由（搭配 `connectWs` from `wsTestClient`）
- 测试 SSE / 流式响应（`inject` 的 mockRes 不支持 pipe，必须用真实 listen）
- 测试 CORS / Helmet / Logger 中间件（需真实 HTTP 响应头）
- 测试错误兜底链（`formatErrorResponse` → `onError` 钩子）

## 公开 API

```ts
import { createTestServer, type TestServer, type TestServerOptions } from '@faapi/faapi';
```

| 符号 | 说明 |
|------|------|
| `createTestServer(options)` | 一键启动测试服务器，返回 `TestServer` |
| `TestServerOptions` | 入参类型：`rootDir` 必填，`patterns`/`dist`/`cors`/`middlewares`/`injectors`/`helmet`/`logger`/`onError`/`config`/`bodyLimit` 可选（`wsRoutes` 由 `scanRoutes` 自动扫描，不接受传入） |
| `TestServer` | 返回类型：含 `server`/`baseUrl`/`routes`/`wsRoutes`/`close()` |

### 入参 `TestServerOptions`

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `rootDir` | `string` | — | 项目根目录（路由源码所在，必填） |
| `patterns` | `string[]` | `['src/api/**/*.ts']` | 路由扫描 glob，相对 `rootDir` |
| `dist` | `string` | 自动 `mkdtemp` 临时目录 | schema 产物输出目录（绝对路径或相对 `rootDir`） |
| `cors` | `CorsOptions \| boolean` | `false`（测试默认禁用，避免污染断言） | CORS 中间件配置 |
| `helmet` | `HelmetOptions \| boolean` | `false` | 安全头配置 |
| `logger` | `LoggerOptions \| boolean` | `false`（避免污染测试输出） | 请求日志配置 |
| `middlewares` | `FaapiMiddleware[]` | `undefined` | 全局中间件（外层洋葱） |
| `injectors` | `InjectorMap` | `undefined` | 全局注入器 |
| `onError` | `(error, ctx) => void` | `undefined` | 请求错误钩子 |
| `config` | `Record<string, unknown>` | `undefined` | 业务配置（注入到 `ctx.config`） |
| `bodyLimit` | `number` | `10MB` | 请求体大小限制 |

### 返回 `TestServer`

| 字段 | 类型 | 说明 |
|------|------|------|
| `server` | `Server` | Node.js HTTP Server 实例（已 listen） |
| `baseUrl` | `string` | 形如 `http://localhost:<随机端口>` |
| `routes` | `RouteManifest` | 排序后的路由清单（业务方可断言） |
| `wsRoutes` | `WsRouteManifest` | WebSocket 路由清单 |
| `schemaDist` | `string` | schema 临时目录绝对路径（业务方调试时可查看生成的 zod.js） |
| `close()` | `() => Promise<void>` | 关闭 server + 清理 schema 目录 + 清空 schema 模块缓存 |

### `close()` 行为

`close()` 内部按顺序执行：

1. `server.closeAllConnections?.()` — 强制断开 WS / 长连接（Node 18+）
2. `server.close()` — 关闭 HTTP server
3. `fs.rm(schemaDist, { recursive: true, force: true })` — 清理临时目录
4. `invalidateSchemaCache()` — 清空 zod.js 模块缓存，避免串扰后续测试

幂等：重复调用 `close()` 不会重复清理（内部 `closed` 标记）。

## 示例

### 1. 基础 E2E 测试

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { createTestServer } from '@faapi/faapi';

const ts = await createTestServer({ rootDir: process.cwd() });

afterAll(() => ts.close());

describe('user API', () => {
  it('GET /api/user?page=1 → 200 + coerce 后的 number', async () => {
    const res = await fetch(`${ts.baseUrl}/api/user?page=1`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.page).toBe(1);  // schema coerce 生效
  });
});
```

### 2. 测试带全局中间件 + 业务配置

```ts
const ts = await createTestServer({
  rootDir: process.cwd(),
  middlewares: [authMiddleware, logMiddleware],
  config: { db: { host: 'localhost', port: 5432 } },
});
```

### 3. 测试 WebSocket 路由（搭配 `connectWs`）

```ts
import { createTestServer, connectWs } from '@faapi/faapi';

const ts = await createTestServer({ rootDir: process.cwd() });
afterAll(() => ts.close());

it('WS /api/chat 收到 onOpen 消息', async () => {
  const { ws, queue } = await connectWs(ts.baseUrl, '/api/chat');
  const msg = await queue.next();
  expect(msg).toBe('connected');
  ws.close();
});
```

### 4. 顶层 setup（推荐模式）

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { createTestServer, type TestServer } from '@faapi/faapi';

let ts: TestServer;

beforeAll(async () => {
  ts = await createTestServer({ rootDir: process.cwd() });
});

afterAll(() => ts.close());
```

## 与其他测试方式对比

| 方式 | 启动 server | 依赖产物 | 走 schema | 走全局中间件 | 走真实 HTTP | 适用场景 |
|------|------------|---------|----------|------------|------------|---------|
| 直接调 handler | 否 | 否 | 否 | 否 | 否 | 纯逻辑 |
| `createContext` + `invokeHandler` | 否 | 否 | 否 | 显式传入 | 否 | 注入/中间件 |
| `createProdApp` + `app.inject` | 否 | ✅ | ✅ | ✅ | 否 | 完整链路（无端口） |
| **`createTestServer` + `fetch`** | **✅（listen 0）** | **自动生成** | **✅** | **✅** | **✅** | **E2E（含 SSE/WS/CORS）** |

## 局限性

| 局限 | 替代方案 |
|------|---------|
| 不读 `faapi.config.ts`（仅用传入的 options） | 用 `createProdApp`（需先 `faapi build`） |
| 不加载插件（`plugins` 字段） | 用 `createProdApp` |
| 不执行 `lifecycle.onReady` / `onClose` | 用 `createProdApp` |
| 无服务器 mock 注入（`app.inject`） | 用 `createProdApp + app.inject` |

## vitest 环境下的别名解析与 vi.mock

业务方 handler 用 TypeScript paths 别名（如 `import { db } from '@/lib/db'`）时，Node 原生 ESM `import()` 无法解析别名，会导致 handler 加载失败、路由表为空、所有请求 404。

`createTestServer` 内部走 `importWithCacheBust`，在 vitest 环境下自动检测 `globalThis.vi.importActual`，优先走 Vite SSR pipeline：
- 识别 `vitest.config.ts` 的 `resolve.alias` 与 tsconfig paths 别名
- 让 `vi.mock` 在加载的 handler 内生效

**前置条件**（满足任一）：
- `vitest.config.ts` 设 `test.globals: true`（推荐，`globalThis.vi` 自动注入）
- 测试文件内显式 `import { vi } from 'vitest'` 后挂到 `globalThis.vi`

**示例**：业务方 vitest.config.ts 配置 `@` 别名 + handler 内用 `@/lib/db`：

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: { globals: true },
});
```

```ts
// src/api/user/handler.ts
import { db } from '@/lib/db';  // 别名引用
export function GET() { return { user: db.user }; }
```

```ts
// src/e2e/test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestServer } from '@faapi/faapi';

let ts;
beforeAll(async () => { ts = await createTestServer({ rootDir: process.cwd() }); });
afterAll(() => ts.close());

it('GET /api/user 走真实 @/lib/db', async () => {
  const res = await fetch(`${ts.baseUrl}/api/user`);
  expect((await res.json()).user.id).toBe('real-user-id');
});
```

**vi.mock 生效**：handler 加载走 Vite pipeline，业务方 `vi.mock('@/lib/db', ...)` 在 createTestServer 内部加载的 handler 内可见：

```ts
// vi.mock 顶层 hoist
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, db: { ...actual.db, source: 'mocked' } };
});

it('vi.mock 生效', async () => {
  const res = await fetch(`${ts.baseUrl}/api/user`);
  expect((await res.json()).source).toBe('mocked');
});
```

非 vitest 环境（`globalThis.vi` 不存在）回退到 Node 原生 `import()`，无副作用。详见 [utils/importWithCacheBust.md](./utils/importWithCacheBust.md)。

## 相关模块

- [server/createServer.ts](./server/createServer.ts) - 底层 HTTP server 创建（`createTestServer` 内部调用）
- [cli/generateSchemaFiles.ts](./cli/generateSchemaFiles.ts) - 生成 zod.js（自动调 `mkdtemp` + `generateSchemaFiles`）
- [router/scanRoutes.ts](./router/scanRoutes.ts) - 路由扫描
- [router/sortRoutes.ts](./router/sortRoutes.ts) - 路由排序
- [validator/validateInput.ts](./validator/validateInput.ts) - schema 模块缓存（`close` 时调 `invalidateSchemaCache`）
- [wsTestClient.ts](./wsTestClient.ts) - WebSocket 测试客户端（搭配 `createTestServer` 测 WS 路由）
- [testing.md](./testing.md) - 业务方测试支持总览
