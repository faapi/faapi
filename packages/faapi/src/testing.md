# 业务方测试支持

一句话概括：公开导出 `createContext` / `invokeHandler`，业务方可在测试中走框架真实注入与序列化逻辑，无需启动 HTTP 服务器。

## 为什么需要

faapi 的 handler 是"函数即接口"——按参数名自动注入 `query`/`body`/`ctx` 等依赖。业务方测试 handler 时面临两个痛点：

1. **直接调用 handler 不走注入**：`GET({ page: 1 })` 缺少 `ctx` 等参数，且未经过 schema coerce、序列化
2. **完整 HTTP 测试过重**：需先编译产物 + 生成 schema + `createServer` + `listen` + `fetch`，测试慢且依赖产物

通过公开导出核心运行时函数，业务方可在**不启动服务器、不依赖 build 产物**的前提下，走框架真实的注入、中间件、序列化逻辑，覆盖 80% 测试场景。

## 公开 API

```ts
import { createContext, invokeHandler } from '@faapi/faapi';
```

| 函数 | 说明 | 参数 |
|------|------|------|
| `createContext(request, params, config?, ip?)` | 从 Web Request 创建 FaapiContext | `request: Request`<br>`params: Record<string, string>`<br>`config?: Record<string, unknown>`（业务配置，默认 `{}`）<br>`ip?: string`（客户端 IP，默认 `''`） |
| `invokeHandler(handler, ctx, body?, middlewares?, injectors?)` | 调用 handler，走注入 + 中间件 + 序列化，返回 Response | `handler: (...args) => unknown`<br>`ctx: FaapiContext`<br>`body?: unknown`（已解析的请求体）<br>`middlewares?: FaapiMiddleware[]`<br>`injectors?: InjectorMap` |

`invokeHandler` 内部已调用 `toResponse` 将 handler 返回值转为 `Response`，业务方拿到的就是 `Response` 对象，可直接用 `res.status` / `await res.json()` 断言。

## 使用场景

### 场景 1：测试 GET handler（query 注入）

```ts
import { createContext, invokeHandler } from '@faapi/faapi';
import { GET } from './handler';

it('GET 返回分页数据', async () => {
  const ctx = createContext(
    new Request('http://localhost/api/user?page=1&pageSize=10'),
    {},                    // params
    { db: { host: '...' } }, // config（业务配置）
  );
  const res = await invokeHandler(GET, ctx);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ page: '1', pageSize: '10' });
});
```

> 注：测试时不走 schema 校验（zod.js 由 build 生成），`query.page` 为 string。如需测 coerce 后的 number 类型，走 E2E 测试。

### 场景 2：测试 POST handler（body 注入）

```ts
import { createContext, invokeHandler } from '@faapi/faapi';
import { POST } from './handler';

it('POST 创建用户', async () => {
  const ctx = createContext(
    new Request('http://localhost/api/user', { method: 'POST' }),
    {},
  );
  const res = await invokeHandler(POST, ctx, { name: 'Alice', email: 'a@b.c' });
  expect(await res.json()).toEqual({ created: true, name: 'Alice' });
});
```

### 场景 3：测试带中间件 + 注入器的 handler

```ts
import { createContext, invokeHandler } from '@faapi/faapi';
import type { FaapiMiddleware, InjectorMap } from '@faapi/faapi';
import { GET } from './handler';

const authMiddleware: FaapiMiddleware = async (ctx, next) => {
  if (!ctx.headers.get('authorization')) return new Response('Unauthorized', { status: 401 });
  ctx.user = { id: 1 };
  await next();
};

const injectors: InjectorMap = {
  user: (ctx) => (ctx as any).user,
  db: () => mockDb,
};

it('带鉴权 + 注入器', async () => {
  const ctx = createContext(
    new Request('http://localhost/api/admin', {
      headers: { authorization: 'Bearer xxx' },
    }),
    {},
  );
  const res = await invokeHandler(GET, ctx, undefined, [authMiddleware], injectors);
  expect(res.status).toBe(200);
});

it('无 token 被中间件拦截', async () => {
  const ctx = createContext(new Request('http://localhost/api/admin'), {});
  const res = await invokeHandler(GET, ctx, undefined, [authMiddleware], injectors);
  expect(res.status).toBe(401);
});
```

### 场景 4：测试动态路由参数

```ts
import { createContext, invokeHandler } from '@faapi/faapi';
import { GET } from './handler';  // src/api/user/[id]/handler.ts

it('params 注入', async () => {
  const ctx = createContext(
    new Request('http://localhost/api/user/123'),
    { id: '123' },          // params
  );
  const res = await invokeHandler(GET, ctx);
  expect(await res.json()).toEqual({ id: '123' });
});
```

### 场景 5：测试 ctx 便捷方法

```ts
import { createContext, invokeHandler } from '@faapi/faapi';
import { GET } from './handler';

it('handler 通过 ctx.json 返回自定义响应', async () => {
  const ctx = createContext(new Request('http://localhost/api/error'), {});
  function handler(context: any) {
    return context.json({ error: 'Not found' }, 404);
  }
  const res = await invokeHandler(handler, ctx);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: 'Not found' });
});
```

## 局限性

| 局限 | 说明 | 替代方案 |
|------|------|----------|
| 不走 schema 校验 | zod.js 由 build 生成，测试时无产物 | 用 E2E 测试（`createProdApp` + `app.inject` 或 `listen` + `fetch`） |
| 不走全局中间件 | 全局中间件由 `faapi.config.ts` 配置，`invokeHandler` 只走传入的中间件 | 显式传入中间件数组，或用 `createProdApp` 启动完整 app |
| SSE / 流式响应 | `invokeHandler` 支持，但需注意 `ctx.sse()` 返回的 Response 不可在测试中消费流 | 测试 SSE 时用 E2E |
| 不走文件上传解析 | `files` / `fields` 注入需 `parseMultipart`，`invokeHandler` 的 `body` 参数为已解析结果 | 自行构造 `body = { files: [], fields: {} }` 传入 |

## 与其他测试方式对比

| 方式 | 适用场景 | 启动服务器 | 依赖产物 | 走注入 | 走中间件 | 走 schema |
|------|---------|-----------|---------|--------|---------|-----------|
| **直接调用 handler** | 纯逻辑测试 | 否 | 否 | 否 | 否 | 否 |
| **`createContext` + `invokeHandler`** | 注入/中间件/序列化测试 | 否 | 否 | ✅ | ✅（显式传入） | 否 |
| `createProdApp` + `app.inject()` | 完整请求链路 | 否 | ✅ | ✅ | ✅ | ✅ |
| `createServer` + `listen` + `fetch` | E2E | ✅ | ✅ | ✅ | ✅ | ✅ |

## 相关模块

- [runtime/createContext.ts](./runtime/createContext.ts) - 创建 FaapiContext
- [runtime/invokeHandler.ts](./runtime/invokeHandler.ts) - 调用 handler + 中间件调度（内部调用 toResponse 转换返回值）
- [injection/injectParams.ts](./injection/injectParams.ts) - 参数注入实现
- [middleware/middlewareTypes.ts](./middleware/middlewareTypes.ts) - 中间件类型
- [middleware/injectorTypes.ts](./middleware/injectorTypes.ts) - 注入器类型
