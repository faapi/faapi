# 场景:配置文件

## 何时加载

用户要写 `faapi.config.ts`、了解有哪些配置字段。

## 配置文件位置

- 默认:`项目根目录/faapi.config.ts`
- 自定义:通过 `loadConfig(rootDir, configPath)` 编程式 API 传入

## 配置字段一览

```ts
// faapi.config.ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  // 统一响应格式 → [response-format.md]
  responseFormat(data) { ... },
  // 全局错误格式 → [response-format.md]
  errorFormat(err) { ... },
  // 生命周期钩子 → [lifecycle.md]
  lifecycle: { onReady, onClose, onError },
  // 扩展 ctx → [extend-context.md]
  extendContext(ctx) { ... },
  // CORS → [cors.md]
  cors: { origin, credentials },
  // 全局中间件 → [middleware.md]
  middlewares: [...],
  // 全局注入器 → [injection.md]
  injectors: { ... },
  // 插件 → [plugins.md]
  plugins: [...],

  // 安全头
  helmet: { xFrameOptions: 'DENY' },
  // 请求体大小限制，默认 10MB
  bodyLimit: 50 * 1024 * 1024,
  // 日志
  logger: { log: pinoLogger.info },
  // HTTP/2
  http2: { key: '/path/to/key.pem', cert: '/path/to/cert.pem' },

  // 自定义业务配置(任意 key)
  db: { host, port },
  redis: { host, port },
} satisfies FaapiConfig;
```

框架内置 key：`cors` / `responseFormat` / `errorFormat` / `lifecycle` / `middlewares` / `injectors` / `extendContext` / `plugins` / `helmet` / `bodyLimit` / `logger` / `http2`。业务配置用其他 key（db、redis 等），不与框架 key 冲突。

## helmet — 安全头

```ts
export default {
  helmet: { xFrameOptions: 'DENY' },
} satisfies FaapiConfig;
// 或简写: helmet: true
```

## bodyLimit — 请求体大小限制

```ts
export default {
  bodyLimit: 50 * 1024 * 1024,  // 50MB
} satisfies FaapiConfig;
// 默认 10MB（10 * 1024 * 1024）
```

## logger — 日志

```ts
import pino from 'pino';
const pinoLogger = pino();

export default {
  logger: { log: pinoLogger.info.bind(pinoLogger) },
} satisfies FaapiConfig;
// 或简写: logger: true（使用 console.log）
```

## http2 — HTTP/2

```ts
export default {
  http2: { key: '/path/to/key.pem', cert: '/path/to/cert.pem' },
} satisfies FaapiConfig;
// 或简写: http2: true（使用默认证书路径）
```

## 自定义业务配置 (ctx.config)

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

详见 [multi-env.md](./multi-env.md)。环境由 `FAAPI_ENV` 或 `NODE_ENV` 决定(默认 `development`)，文件命名 `faapi.config.{env}.ts`，深度合并。

## ETag / 中间件实例

faapi 不内置 compression / rateLimit / timeout / cluster 等。详见 [recipes.md](./recipes.md)。

## 常见坑点

### 1. responseFormat 不包装 Response

```ts
export function GET() {
  return new Response('Not found', { status: 404 });
  // responseFormat 不包装,原样透传
}
```

### 2. errorFormat 未处理有兜底

`errorFormat` 返回 `null`/`undefined` 或自身抛错,框架用内置 `formatErrorResponse` 兜底。

### 3. 自定义配置 key 与框架 key 冲突

```ts
// ❌ middlewares 会被当成框架配置
export default {
  middlewares: [...],  // 这是框架的中间件配置,不是业务配置
};
```

框架内置 key:`cors`/`responseFormat`/`errorFormat`/`lifecycle`/`middlewares`/`injectors`/`extendContext`/`plugins`/`helmet`/`bodyLimit`/`logger`/`http2`。业务配置用其他 key。

## 检查清单

- [ ] 文件名 `faapi.config.ts`(或 `.production.ts` 等)
- [ ] 用 `satisfies FaapiConfig` 做类型检查
- [ ] 业务配置 key 不与框架 key 冲突
- [ ] `pnpm typecheck` 通过
