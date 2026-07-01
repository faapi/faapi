# 场景:配置文件

## 何时加载

用户要写 `faapi.config.ts`、配置 responseFormat/errorFormat/生命周期钩子/全局中间件/多环境/ctx 扩展。

## 配置文件位置

- 默认:`项目根目录/faapi.config.ts`
- 自定义:`faapi --config path/to/config.ts`

## 配置字段

```ts
// faapi.config.ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  // 统一响应格式
  responseFormat(data) { ... },

  // 全局错误格式
  errorFormat(err) { ... },

  // 生命周期钩子
  lifecycle: { onReady, onClose, onError },

  // 扩展 ctx
  extendContext(ctx) { ... },

  // CORS
  cors: { origin, credentials },

  // 全局中间件
  middlewares: [...],

  // 全局注入器
  injectors: { ... },

  // 静态文件目录
  staticDir: 'public',

  // 插件
  plugins: [...],

  // 自定义业务配置(任意 key)
  db: { host, port },
  redis: { host, port },
} satisfies FaapiConfig;
```

## responseFormat — 统一响应包装

handler 返回的对象自动包装:

```ts
export default {
  responseFormat(data) {
    return { code: 0, data, message: 'success' };
  },
} satisfies FaapiConfig;
```

```ts
// handler
export function GET() {
  return { name: 'foo' };
}
// 实际响应: { code: 0, data: { name: 'foo' }, message: 'success' }
```

**不包装的情况**:
- handler 返回 `Response` 对象
- handler 返回 `ctx.json()`/`ctx.html()`/`ctx.redirect()` 结果
- SSE 响应(`ctx.sse()`)
- 抛错(走 errorFormat)

## errorFormat — 错误响应格式

优先于内置 `formatErrorResponse` 处理错误。返回 `Response` 表示已处理；返回 `null`/`undefined` 表示不处理,由内置 `formatErrorResponse` 兜底:

```ts
export default {
  errorFormat(err) {
    // 仅处理关心的错误,其余返回 null 交给框架兜底
    if (!(err instanceof ValidationError)) return null;
    return new Response(
      JSON.stringify({ code: 422, message: err.message }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    );
  },
} satisfies FaapiConfig;
```

也可全量处理(返回 `Response` 即可):

```ts
export default {
  errorFormat(err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as any)?.statusCode ?? 500;
    return new Response(
      JSON.stringify({ code: status, data: null, message }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  },
} satisfies FaapiConfig;
```

**错误兜底链**:
1. `errorFormat` 返回 `Response` → 已处理
2. `errorFormat` 返回 `null`/`undefined`(未处理)或抛错 → 内置 `formatErrorResponse` 兜底
3. 内置兜底仍失败 → 最简 500

## lifecycle — 生命周期钩子

```ts
export default {
  lifecycle: {
    async onReady({ rootDir, routes, server }) {
      // server 启动后调用
      // 初始化数据库连接、Redis 等
      console.log(`Server ready with ${routes.length} routes`);
    },
    async onClose({ rootDir, server }) {
      // 优雅关闭时调用(SIGTERM/SIGINT)
      // 清理资源
      console.log('Server shutting down');
    },
    onError(error, ctx) {
      // 请求错误已发出后触发(参考 Fastify onError 语义)
      // 用于副作用:日志/告警/链路追踪
      // 不修改已发出的响应;自身抛错被忽略
      console.error(`[onError] ${ctx.method} ${ctx.path}`, error);
    },
  },
} satisfies FaapiConfig;
```

## extendContext — 扩展 ctx

```ts
export default {
  extendContext(ctx) {
    ctx.t = (key: string) => key;          // i18n
    ctx.now = () => Date.now();
  },
} satisfies FaapiConfig;
```

配合 `declare module` 增强类型:

```ts
// types.ts(项目任意位置)
declare module '@faapi/faapi' {
  interface FaapiContext {
    t: (key: string) => string;
    now: () => number;
    user?: { id: number; name: string };
  }
}
```

## cors — CORS 配置

```ts
export default {
  cors: { origin: ['https://example.com'], credentials: true },
} satisfies FaapiConfig;
```

覆盖 CLI `--no-cors`。dev 模式默认启用 CORS。

## middlewares — 全局中间件

```ts
export default {
  middlewares: [
    async (ctx, next) => {
      ctx.requestId = crypto.randomUUID();
      await next();
    },
  ],
} satisfies FaapiConfig;
```

**执行顺序**:CORS → 全局 → 目录(根→路由)→ handler。对所有路由(HTTP + WebSocket 握手)生效,最外层。

详见 [middleware.md](./middleware.md)。

## injectors — 全局注入器

```ts
export default {
  injectors: {
    db: () => getDbConnection(),
    redis: () => getRedisClient(),
  },
} satisfies FaapiConfig;
```

目录注入器覆盖同名全局注入器。详见 [injection.md](./injection.md)。

## staticDir — 静态文件

```ts
export default {
  staticDir: 'public',  // 覆盖 CLI --static
} satisfies FaapiConfig;
```

## plugins — 插件

应用级扩展,在 server.listen 之前 setup 一次。插件可包装 HTTP/WS handler,用于集成其他框架。

```ts
export default {
  plugins: [
    '@faapi/schema',                                    // 包名
    ['@faapi/schema', { stdio: true }],                  // 带选项
    { package: '@faapi/schema', enable: true },          // 完整声明
    { path: './my-plugin' },                              // 本地路径
  ],
} satisfies FaapiConfig;
```

### 插件接口

```ts
interface FaapiPlugin {
  name: string;
  setup(ctx: PluginContext): void | Promise<void>;
}

interface PluginContext {
  rootDir: string;
  routes: RouteManifest;
  server: Server;                  // 未 listen
  config: Record<string, unknown>;
  options?: unknown;               // 来自声明中的 options 字段或元组第二个元素
  wrapHandler?: (fn: (original: RequestHandler) => RequestHandler) => void;
  wrapUpgradeHandler?: (fn: (original: UpgradeHandler | undefined) => UpgradeHandler) => void;
}
```

### wrapHandler / wrapUpgradeHandler

插件通过这两个方法注册包装函数,框架在 listen 之前按注册顺序嵌套应用:

```ts
// 插件 setup 中
ctx.wrapHandler((original) => (req, res) => {
  if (req.url?.startsWith('/api/')) {
    original(req, res);  // 走 faapi
  } else {
    otherHandler(req, res);  // 走其他框架
  }
});
```

多个包装器按注册顺序嵌套:`finalHandler = wrap1(wrap2(originalHandler))`。

### 加载时机

插件在 server 创建后、listen 之前(beforeListen 钩子中)加载。这确保插件能包装 handler,且包装后的 handler 在 server 开始处理请求前生效。

### 内置插件

| 包名 | 功能 |
|------|------|
| `@faapi/schema` | 路由 schema 生成 + 通过 MCP 协议暴露给 AI 助手 |
| `@faapi/next` | Next.js + faapi 集成,`/api/*` 走 faapi,其余走 Next.js |

### 集成 Next.js 示例

```ts
export default {
  plugins: [
    '@faapi/next',
    // 或带选项:
    // ['@faapi/next', { dir: '.', apiPrefix: '/api', dev: true }],
  ],
} satisfies FaapiConfig;
```

`@faapi/next` 插件选项:

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `dev` | `NODE_ENV !== 'production'` | 开发模式 |
| `dir` | `'.'` | Next.js 项目目录 |
| `apiPrefix` | `'/api'` | faapi API 路径前缀(决定哪些请求走 faapi) |

启动用 `faapi` 主 CLI,自动加载插件。详见 [init.md](./init.md) 的集成 Next.js 形态。

### 自定义插件

```ts
// my-plugin/index.ts
import type { FaapiPlugin } from '@faapi/faapi';

export default {
  name: 'my-plugin',
  setup(ctx) {
    console.log(`Loaded ${ctx.routes.length} routes`);
    // 可包装 handler、启动后台服务等
  },
} satisfies FaapiPlugin;
```

```ts
// faapi.config.ts
export default {
  plugins: [{ path: './my-plugin' }],
} satisfies FaapiConfig;
```

**与中间件的区别**:中间件拦截每个请求(洋葱模型),插件在启动时 setup 一次(如启动后台服务、注册协议、包装 handler 集成其他框架)。

## 自定义业务配置(ctx.config)

任意 key 自动注入到每个请求的 `ctx.config`:

```ts
export default {
  db: { host: 'localhost', port: 5432 },
  redis: { host: '127.0.0.1', port: 6379 },
} satisfies FaapiConfig;
```

```ts
// handler
export function GET(ctx) {
  return { dbHost: ctx.config.db.host };
}
```

配合 `declare module` 增强类型:

```ts
declare module '@faapi/faapi' {
  interface FaapiContextConfig {
    db: { host: string; port: number };
    redis: { host: string; port: number };
  }
}
```

## 多环境配置

环境由 `FAAPI_ENV` 或 `NODE_ENV` 决定(默认 `development`),优先级 `FAAPI_ENV > NODE_ENV > 'development'`。

```ts
// faapi.config.ts — 基础配置
export default {
  db: { host: 'localhost', port: 5432 },
} satisfies FaapiConfig;

// faapi.config.production.ts — 生产环境覆盖
export default {
  db: { host: 'db.production.com', port: 5432 },
} satisfies FaapiConfig;
```

环境配置与基础配置**深度合并**,环境配置优先。

## 常见坑点

### 1. responseFormat 不包装 Response

```ts
export function GET() {
  return new Response('Not found', { status: 404 });
  // responseFormat 不包装,原样透传
}
```

### 2. errorFormat 未处理或抛错有兜底

`errorFormat` 返回 `null`/`undefined`(未处理)或自身抛错,框架用内置 `formatErrorResponse` 兜底,不会崩溃。

### 3. extendContext 类型扩展

```ts
// ❌ 运行时报错:ctx.t is not a function
export default {
  extendContext(ctx) {
    // 没有挂载 t,但 handler 用了
  },
};

// ✅
export default {
  extendContext(ctx) {
    ctx.t = (key: string) => key;
  },
};
```

### 4. 自定义配置 key 与框架 key 冲突

```ts
// ❌ middlewares 会被当成框架配置
export default {
  middlewares: [...],  // 这是框架的中间件配置,不是业务配置
};
```

框架内置 key:`port`/`staticDir`/`cors`/`responseFormat`/`errorFormat`/`lifecycle`/`middlewares`/`injectors`/`extendContext`/`plugins`。

业务配置用其他 key(db、redis、cache 等)。

## 检查清单

- [ ] 文件名 `faapi.config.ts`(或 `.production.ts` 等)
- [ ] 用 `satisfies FaapiConfig` 做类型检查
- [ ] responseFormat 返回 Response 或对象；errorFormat 返回 Response 或 null/undefined(未处理时)
- [ ] lifecycle 钩子签名正确
- [ ] 业务配置 key 不与框架 key 冲突
- [ ] `pnpm typecheck` 通过

## 相关场景

- [middleware.md](./middleware.md) — 中间件详细规范
- [injection.md](./injection.md) — 注入器详细规范
- [init.md](./init.md) — 配置文件加载顺序
