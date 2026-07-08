# 业务方测试 handler

何时使用：用户要测试 faapi handler / 中间件 / 注入器时。

## 核心思路

faapi 的 handler 是"函数即接口"——按参数名自动注入 `query`/`body`/`ctx` 等依赖。框架公开导出 `createContext` / `invokeHandler`，业务方可在**不启动服务器、不依赖 build 产物**的前提下，走框架真实的注入、中间件、序列化逻辑。

## 公开 API

```ts
import { createContext, invokeHandler } from '@faapi/faapi';
```

| 函数 | 说明 |
|------|------|
| `createContext(request, params, config?, ip?)` | 从 Web Request 创建 FaapiContext |
| `invokeHandler(handler, ctx, body?, middlewares?, injectors?)` | 调用 handler，走注入 + 中间件 + 序列化，返回 Response |

`invokeHandler` 内部已调用 `toResponse` 将 handler 返回值转为 `Response`，业务方拿到的就是 `Response` 对象，可直接用 `res.status` / `await res.json()` 断言。

## 测试模式选择

| 方式 | 适用场景 | 启动服务器 | 依赖产物 | 走注入 | 走中间件 | 走 schema |
|------|---------|-----------|---------|--------|---------|-----------|
| 直接调用 handler | 纯逻辑测试 | 否 | 否 | 否 | 否 | 否 |
| **`createContext` + `invokeHandler`** | **注入/中间件/序列化测试** | **否** | **否** | **✅** | **✅（显式传入）** | **否** |
| `createProdApp` + `app.inject()` | 完整请求链路 | 否 | ✅ | ✅ | ✅ | ✅ |
| `createServer` + `listen` + `fetch` | E2E | ✅ | ✅ | ✅ | ✅ | ✅ |

推荐分层：纯逻辑用直接调用，注入/中间件用 `invokeHandler`，完整链路用 `createProdApp` + `app.inject`。

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

## 检查清单

- [ ] 测试文件使用 `.test.ts` 后缀，与 handler 同目录
- [ ] 纯逻辑测试直接调用 handler，不走框架
- [ ] 注入/中间件/序列化测试用 `createContext` + `invokeHandler`
- [ ] 完整链路测试用 `createProdApp` + `app.inject`（需 build 产物）
- [ ] handler 抛错测试用 `expect(...).rejects.toThrow()`
- [ ] async handler 用 `await invokeHandler(...)`
