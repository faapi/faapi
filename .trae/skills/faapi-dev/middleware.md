# 场景:中间件开发

## 何时加载

用户要写中间件、鉴权、日志、错误处理、限流,或理解洋葱模型。

## 中间件文件约定

| 约定 | 说明 |
|------|------|
| 文件名 | `middlewares.ts`(固定) |
| 位置 | 任意目录(`api/`、`api/user/` 等都可以) |
| 作用范围 | 当前目录及所有子目录的路由 |
| 默认导出 | 中间件数组(洋葱模型,单一 async 函数) |

**就近查找**:从路由文件所在目录开始,逐级向上查找 `middlewares.ts`,所有找到的中间件**按根→路由顺序叠加**。

## 中间件签名

```ts
import type { FaapiMiddleware } from '@faapi/faapi';

const middleware: FaapiMiddleware = async (ctx, next) => {
  // await next() 之前:handler 执行前
  // await next() 之后:handler 执行后
  // 不调用 next():拦截请求
};

export default [middleware] satisfies FaapiMiddleware[];
```

**单一 async 函数** `(ctx, next) => Promise<void | Response>`:
- `ctx` — 请求上下文(可读写)
- `next` — 调用下一个中间件/handler
- 返回 `Response` — 提前拦截
- 不返回 / `await next()` — 继续执行

## 中间件行为

| 行为 | 时机 | 用途 |
|------|------|------|
| `await next()` 之前 | handler 执行前 | 日志、鉴权拦截、塞值到 ctx |
| `await next()` 之后 | handler 执行后 | 日志、响应修改 |
| 不调用 `next()` | 拦截请求 | 鉴权失败、限流 |
| `try/catch` 包裹 `next()` | 错误捕获 | 错误处理、日志 |

**注意**:faapi 只有"await next() 之前/之后"的代码段,**没有"全局 before/after"概念**。每个中间件自己控制前后逻辑,通过 `await next()` 衔接。

## 基本示例

### 鉴权(拦截)

```ts
// src/api/admin/middlewares.ts
import type { FaapiMiddleware } from '@faapi/faapi';

export default [
  async (ctx, next) => {
    const token = ctx.headers.get('authorization');
    if (!token) {
      return new Response('Unauthorized', { status: 401 });
    }
    // 塞值到 ctx,handler 可读
    ctx.user = { id: 1, name: 'admin' };
    await next();
  },
] satisfies FaapiMiddleware[];
```

### 日志(before/after 一体)

```ts
async (ctx, next) => {
  const start = Date.now();
  await next();
  console.log(`${ctx.method} ${ctx.path} ${Date.now() - start}ms`);
}
```

### 错误处理(try/catch)

```ts
async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error(`${ctx.method} ${ctx.path} error:`, err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
```

### 限流(不调用 next)

```ts
async (ctx, next) => {
  if (rateLimitExceeded(ctx)) {
    return new Response('Too Many Requests', { status: 429 });
  }
  await next();
}
```

## 父子中间件叠加

```
api/
├── middlewares.ts              ← 全局中间件(根)
├── user/
│   ├── middlewares.ts          ← user 目录中间件
│   └── [id]/handler.ts
└── admin/
    ├── middlewares.ts          ← admin 目录中间件
    └── handler.ts
```

**执行顺序**:CORS → 全局(faapi.config.ts middlewares)→ 目录(根→路由)→ handler

```
请求 → 全局mw → api/middlewares.ts → api/user/middlewares.ts → handler
```

每个中间件 `await next()` 衔接下一个,形成洋葱:

```
全局 before → 目录 before → handler → 目录 after → 全局 after
```

## 全局中间件

通过 `faapi.config.ts` 的 `middlewares` 字段配置,**对所有路由**(HTTP + WebSocket 握手)生效,最外层:

```ts
// faapi.config.ts
export default {
  middlewares: [
    async (ctx, next) => {
      ctx.requestId = crypto.randomUUID();
      await next();
    },
  ],
};
```

顺序:CORS → 全局 → 目录(根→路由)→ handler。详见 [config.md](./config.md)。

## 注入器(injectors)

中间件文件可同时导出 `injectors`,提供依赖注入:

```ts
// src/api/admin/middlewares.ts
import type { FaapiMiddleware, InjectorMap } from '@faapi/faapi';

export default [
  async (ctx, next) => {
    ctx.user = await getUserFromToken(ctx.headers.get('authorization'));
    await next();
  },
] satisfies FaapiMiddleware[];

export const injectors: InjectorMap = {
  db: () => getDbConnection(),
  user: (ctx) => ctx.user,  // 取中间件塞的值
};
```

handler 参数名匹配 injectors 的 key:

```ts
// src/api/admin/handler.ts
export function GET(db: Db, user: User) {
  // db 来自 injectors.db
  // user 来自 injectors.user(中间件塞的)
  return { userId: user.id };
}
```

详见 [injection.md](./injection.md)。

## ctx 上下文

| 属性/方法 | 说明 |
|----------|------|
| `ctx.request` | Web Request 对象 |
| `ctx.method` | HTTP 方法 |
| `ctx.path` | 请求路径 |
| `ctx.headers` | Headers 对象 |
| `ctx.query` | URL 查询参数（URLSearchParams） |
| `ctx.params` | 动态路由参数 |
| `ctx.cookies` | Cookie 键值对 |
| `ctx.ip` | 客户端 IP（X-Forwarded-For 优先） |
| `ctx.config` | 配置文件中的自定义业务配置 |
| `ctx.json(data, status?)` | 返回 JSON 响应 |
| `ctx.html(html, status?)` | 返回 HTML 响应 |
| `ctx.redirect(url, status?)` | 返回重定向响应 |
| `ctx.sse()` | 创建 SSE writer |
| `ctx.setStatus(status)` | 设置响应状态码 |
| `ctx.setHeader(key, value)` | 设置响应头 |
| `ctx.setETag(value)` | 设置 ETag 响应头 |
| `ctx.getCookie(name)` | 读取单个 cookie |
| `ctx.setCookie(name, value, opts?)` | 设置 cookie |
| `ctx.deleteCookie(name)` | 删除 cookie（设置过期） |

**扩展 ctx**:

```ts
// faapi.config.ts
export default {
  extendContext(ctx) {
    ctx.t = (key: string) => key;  // i18n
  },
};
```

配合 `declare module '@faapi/faapi'` 增强类型:

```ts
// types.ts
declare module '@faapi/faapi' {
  interface FaapiContext {
    user?: { id: number; name: string };
    requestId?: string;
    t: (key: string) => string;
  }
}
```

## 常见坑点

### 1. 忘记 await next()

```ts
// ❌ handler 不会执行
async (ctx, next) => {
  console.log('before');
  // 忘记 await next(),handler 被跳过
}

// ✅
async (ctx, next) => {
  console.log('before');
  await next();
  console.log('after');
}
```

### 2. 拦截后还调用 next()

```ts
// ❌ 已经返回 401 了,next() 还在跑
async (ctx, next) => {
  if (!ctx.headers.get('authorization')) {
    return new Response('Unauthorized', { status: 401 });
  }
  await next();  // 即使拦截了也会执行
}

// ✅ 拦截后直接 return,不调用 next
async (ctx, next) => {
  if (!ctx.headers.get('authorization')) {
    return new Response('Unauthorized', { status: 401 });
  }
  await next();
}
```

实际上 `return new Response(...)` 后函数已退出,`await next()` 不会执行。但**逻辑要清晰**,拦截就 return,放行就 next。

### 3. 中间件文件位置不对

```
❌ app/middlewares.ts              ← 不在 api/ 下,不生效
❌ api/user/middleware.ts      ← 文件名错了,应该是 middlewares.ts
✅ api/user/middlewares.ts
```

### 4. 默认导出不是数组

```ts
// ❌ 默认导出单个函数
export default async (ctx, next) => { ... };

// ✅ 默认导出数组
export default [
  async (ctx, next) => { ... },
] satisfies FaapiMiddleware[];
```

## 检查清单

- [ ] 文件名是 `middlewares.ts`(带 s)
- [ ] 在 `api/` 目录下
- [ ] 默认导出是数组
- [ ] 每个中间件是 `async (ctx, next) => Promise<void | Response>`
- [ ] 拦截场景不调用 `next()`
- [ ] 放行场景 `await next()`
- [ ] 用 `satisfies FaapiMiddleware[]` 做类型检查
- [ ] `pnpm typecheck` 通过

## 相关场景

- [injection.md](./injection.md) — injectors 注入器
- [config.md](./config.md) — 全局中间件、extendContext
- [route.md](./route.md) — handler 如何读 ctx 上的值
- [realtime.md](./realtime.md) — WebSocket 握手阶段中间件
