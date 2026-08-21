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
  // 生命周期钩子 → [lifecycle.md]
  lifecycle: { onReady, onClose, onError },
  // 扩展 ctx → [extend-context.md]
  extendContext(ctx) { ... },
  // CORS → [cors.md]
  cors: { origin, credentials },
  // 全局中间件 → [middleware.md]
  // 统一响应格式 / 自定义错误响应 → [response.md]
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
  // agent 子系统配置 → [agent.md](./agent.md)
  agent: {
    llm: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o' },
    defaultAgent: 'researcher',
    maxTurns: 10,
    maxAgentDepth: 3,
    defaultTools: ['weather.getWeather'],
  },

  // 自定义业务配置(任意 key)
  db: { host, port },
  redis: { host, port },
} satisfies FaapiConfig;
```

框架内置 key：`cors` / `lifecycle` / `middlewares` / `injectors` / `extendContext` / `plugins` / `helmet` / `bodyLimit` / `logger` / `http2` / `agent`。业务配置用其他 key（db、redis 等），不与框架 key 冲突。

> 统一响应格式与自定义错误响应通过辅助函数 + 全局中间件实现,详见 [response.md](./response.md)。

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

默认启用（与 cors 一致），零配置即输出 `GET /api/users 200 12ms` 格式日志。

```ts
import pino from 'pino';
const pinoLogger = pino();

export default {
  // 默认启用（undefined）,使用 console.log
  // 或自定义:
  logger: { log: pinoLogger.info.bind(pinoLogger) },
  // 或显式启用:
  logger: true,
  // 或关闭:
  logger: false,
} satisfies FaapiConfig;
```

完全自定义日志中间件：`logger: false` + `middlewares: [myCustomLogger]`。

## http2 — HTTP/2

```ts
export default {
  http2: { key: '/path/to/key.pem', cert: '/path/to/cert.pem' },
} satisfies FaapiConfig;
// 或简写: http2: true（仍需通过环境/外部代理提供 TLS 证书，代码中不读取默认证书路径）
```

> 注：`http2: true` 时 `key`/`cert` 为 undefined，会创建无证书的 HTTP/2 secure server。生产环境建议在反向代理（nginx/Caddy）层终止 TLS，faapi 仅监听 HTTP；如需 faapi 直接终止 TLS，必须显式提供 `key`/`cert`。

## agent — agent 子系统全局配置

agent 子系统需配合 `@faapi/agent` 插件使用（详见 [agent.md](./agent.md)）：

```ts
export default {
  agent: {
    llm: {                                    // LLM 提供方配置
      provider: 'openai',                     // 目前支持 'openai'（OpenAI 兼容 API）
      apiKey: process.env.OPENAI_API_KEY,     // 从 .env 读取
      model: 'gpt-4o',                        // 默认模型
      // baseURL: 'https://api.openai.com/v1', // 可选，OpenAI 兼容 API（Azure / 中转服务）
      // temperature: 0.7,                     // 透传给 LLM API
    },
    defaultAgent: 'researcher',               // handler 的 `agent` 参数注入读取此值
    maxTurns: 10,                             // 默认最大对话轮数（agent 自身 config.maxTurns 优先）
    maxAgentDepth: 3,                         // agent 调用 agent 的最大递归深度（默认 3）
    defaultTools: ['weather.getWeather'], // 所有 agent 共享的 tool（与 agent 自身 tools 合并）
  },
  plugins: ['@faapi/agent'],                  // 必须显式声明插件
} satisfies FaapiConfig;
```

| 字段 | 缺失行为 |
|------|---------|
| `agent` 整块 | 不注册 agent handle 工厂，`agent` 参数注入 `undefined` |
| `agent.llm` | 不注册工厂，打印警告 |
| `agent.defaultAgent` | 不注册工厂，打印警告 |
| `agent.maxTurns` | 用 agent 自身 `config.maxTurns`，都无时用框架默认 |
| `agent.maxAgentDepth` | 用默认值 3 |
| `agent.defaultTools` | 不追加共享 tool |

agent 自身的 `config` 块字段（`systemPrompt` / `tools` / `agents` / `model` / `maxTurns`）优先于全局配置，详见 [agent.md](./agent.md)。

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

详见 [multi-env.md](./multi-env.md)。多环境差异通过 `.env` 系列文件实现（参考 Next.js），启动时 `loadEnv` 加载到 `process.env`，`faapi.config.ts` 通过 `process.env.XXX` 读取。

```ts
// faapi.config.ts
export default {
  db: { host: process.env.DB_HOST ?? 'localhost', port: 5432 },
} satisfies FaapiConfig;
```

## ETag / 中间件实例

faapi 不内置 rateLimit / timeout / cluster 等。详见 [recipes.md](./recipes.md)。响应压缩建议通过反向代理（nginx/Caddy）处理。

## 常见坑点

### 1. handler 返回 Response 原样透传

```ts
export function GET() {
  return new Response('Not found', { status: 404 });
  // 框架不包装,原样透传
}
```

### 2. 自定义错误响应走全局中间件

handler 抛错未被全局中间件 `try/catch` 捕获时,框架用内置 `formatErrorResponse` 兜底。自定义错误响应在全局中间件中 `try/catch next()` 后 `return ctx.json(...)` 拦截,项目自定义错误类用 `instanceof` 判断,详见 [response.md](./response.md)。

### 3. 自定义配置 key 与框架 key 冲突

```ts
// ❌ middlewares 会被当成框架配置
export default {
  middlewares: [...],  // 这是框架的中间件配置,不是业务配置
};
```

框架内置 key:`cors`/`lifecycle`/`middlewares`/`injectors`/`extendContext`/`plugins`/`helmet`/`bodyLimit`/`logger`/`http2`/`agent`。业务配置用其他 key。

## 检查清单

- [ ] 文件名 `faapi.config.ts`
- [ ] 用 `satisfies FaapiConfig` 做类型检查
- [ ] 业务配置 key 不与框架 key 冲突
- [ ] 敏感值通过 `process.env.XXX` 读取（配合 `.env` 文件，见 [multi-env.md](./multi-env.md)）
- [ ] `pnpm typecheck` 通过
