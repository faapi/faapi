# 中间件系统

中间件系统采用洋葱模型，单一 async 函数通过 `await next()` 衔接前置/后置逻辑；依赖注入由独立的注入器（injector）机制提供，与中间件解耦。

## 核心类型

[FaapiMiddleware](./middlewareTypes.ts) 是单一 async 函数 `(ctx, next) => Promise<void | Response>`：

| 行为 | 说明 |
| --- | --- |
| `await next()` 之前 | 前置处理（鉴权、日志开始计时等） |
| `await next()` 之后 | 后置处理（日志输出、响应修改等） |
| 不调用 `next()` | 拦截请求（必须返回 Response） |
| 返回 `Response` | 作为响应（拦截或替换） |
| 返回 `void` | 使用 `await next()` 返回的内层响应 |
| `try/catch` 包裹 `next()` | 捕获内层错误（错误处理） |

[InjectorMap](./injectorTypes.ts) 是注入器映射表，按参数名匹配 handler 参数，提供依赖：

```ts
export type Injector = (ctx: FaapiContext) => unknown | Promise<unknown>;
export type InjectorMap = Record<string, Injector>;
```

## 内置中间件

| 模块 | 说明 |
| --- | --- |
| [cors.ts](./cors.ts) | CORS 处理，支持 origin 反射、预检请求、自定义头 |
| [helmet.ts](./helmet.ts) | 安全响应头（CSP/X-Frame-Options/HSTS 等 13 个），通过 `faapi.config.ts` 的 `helmet` 选项配置 |
| [logger.ts](./logger.ts) | 请求日志，格式：`GET /api/users 200 12ms` |

## middlewares.ts 文件格式

每个目录可放置 `middlewares.ts`，导出两部分（都可选）：

```ts
import type { FaapiMiddleware, InjectorMap } from '@faapi/faapi';

// 默认导出：中间件数组（洋葱模型）
export default [
  async (ctx, next) => {
    const token = ctx.headers.get('authorization');
    if (!token) return new Response('Unauthorized', { status: 401 });
    ctx.user = await verifyToken(token);
    await next();
  },
  async (ctx, next) => {
    const start = Date.now();
    await next();
    console.log(`${ctx.method} ${ctx.path} ${Date.now() - start}ms`);
  },
  async (ctx, next) => {
    try { await next(); }
    catch (err) { return new Response(JSON.stringify({ error: String(err) }), { status: 500 }); }
  },
] satisfies FaapiMiddleware[];

// 命名导出 injectors：注入器映射表
export const injectors: InjectorMap = {
  db: () => getDbConnection(),
  user: (ctx) => ctx.user,
};
```

## 加载机制

[loadMiddlewares.ts](./loadMiddlewares.ts) 从文件系统加载 `middlewares.ts`，校验导出格式。加载流程：

1. [scanRoutes](../router/scanRoutes.ts) 扫描路由时，从路由文件所在目录向上逐级查找所有 `middlewares.ts`
2. 按从根到路由目录的顺序合并中间件和注入器（父级在前，子级在后）
3. 子级注入器覆盖父级同名注入器
4. 校验规则：中间件数组每项必须是函数；注入器每个值必须是函数
5. 加载结果缓存到 `middlewareCache`，避免重复导入
6. 中间件挂载到路由记录的 `middlewares` 字段，注入器挂载到 `injectors` 字段

## 全局中间件

除目录级 `middlewares.ts` 外，可在 `faapi.config.ts` 中通过 `middlewares` 字段声明全局中间件，对所有路由（HTTP + WebSocket 握手）生效。

```ts
// faapi.config.ts
import type { FaapiConfig, FaapiMiddleware } from '@faapi/faapi';

const requestId: FaapiMiddleware = async (ctx, next) => {
  ctx.requestId = crypto.randomUUID();  // 塞值，handler/目录中间件可读
  await next();
};

export default {
  middlewares: [requestId],
} satisfies FaapiConfig;
```

**执行顺序**：全局中间件在最外层，目录中间件在内层，形成一条洋葱链（`await next()` 两侧的代码段属于同一个中间件）：

```
全局 mw(await next 之前) → 目录 mw(await next 之前) → handler → 目录 mw(await next 之后) → 全局 mw(await next 之后)
```

**与目录中间件的关系**：
- 全局中间件独立于 `route.middlewares` 字段，扫描产物不包含全局中间件
- 执行时由 [createServer](../server/createServer.ts) / [handleWsUpgrade](../server/handleWsUpgrade.ts) 在 `compose` 时把全局中间件前置
- 全局中间件 `await next()` 之前的代码先于目录中间件执行，之后的代码后于目录中间件执行；目录中间件不调 `next` 则全局中间件 `await next()` 之后的代码不执行
- 全局中间件拦截（返回 Response，不调 `next`）则目录中间件和 handler 不执行

**与内置中间件的关系**：CORS 走 `config.cors` 配置，logger 由用户自行通过 `middlewares` 挂载。全局中间件在 CORS 之后、目录中间件之前执行。

**注入器**：全局中间件塞入 ctx 的值，目录注入器和 handler 注入器均可读取（共享同一个 ctx）。

## 全局注入器

除目录级 `middlewares.ts` 的 `export const injectors` 外，可在 `faapi.config.ts` 中通过 `injectors` 字段声明全局注入器，对所有路由的 handler 参数注入生效。

```ts
// faapi.config.ts
import type { FaapiConfig, InjectorMap } from '@faapi/faapi';

export default {
  injectors: {
    db: () => getDbConnection(),       // 全局依赖，所有路由可用
    redis: () => getRedis(),
  },
} satisfies FaapiConfig;
```

**合并规则**：`{ ...全局注入器, ...目录注入器 }`，目录注入器覆盖全局同名。合并发生在 handler 参数注入时，不修改 `route.injectors` 字段。

**与目录中间件分离**：全局注入器独立于中间件链，仅提供依赖。若只想共享依赖、不共享中间件逻辑，用全局注入器而非根 `middlewares.ts`。

**执行链**：
- HTTP：`invokeHandler` 收到 `mergedInjectors = { ...globalInjectors, ...route.injectors }`，按 handler 参数名匹配执行
- WebSocket：WS handler 签名为 `WS(ctx: WsContext)` 单参数，不走注入器机制；全局依赖通过 `ctx.config` 访问

## 执行流程

在 [invokeHandler](../runtime/invokeHandler.ts) 中按洋葱模型调度：

```
mw1(await next 之前) → mw2(await next 之前) → ... → 注入器（按需）→ handler → ... → mw2(await next 之后) → mw1(await next 之后)
```

中间件不调用 `next()` 即拦截请求；`try/catch` 包裹 `next()` 可捕获内层错误。

## 注入器按需执行

注入器只对 handler 声明的参数执行，避免无谓计算。内置注入类型（query、body、headers、params、context、ctx、cookies、ip、files、fields）优先于注入器，不会被注入器覆盖。

```ts
// handler 只需要 db 参数，所以只有 db 注入器会执行
export function GET(db: DbConn) { ... }
```

注入器可读取中间件塞进 ctx 的值（如鉴权中间件塞的 ctx.user），实现"中间件管流程、注入器管依赖"的协作。
