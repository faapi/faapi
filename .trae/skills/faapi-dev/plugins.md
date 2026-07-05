# 场景:插件系统

## 何时加载

用户要写插件、集成 Next.js、加载 `@faapi/schema` 或 `@faapi/next`。

## 配置方式

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

## 插件接口

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

## wrapHandler / wrapUpgradeHandler

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

## 加载时机

插件在 server 创建后、listen 之前(beforeListen 钩子中)加载。这确保插件能包装 handler,且包装后的 handler 在 server 开始处理请求前生效。

## 内置插件

| 包名 | 功能 |
|------|------|
| `@faapi/schema` | 路由 schema 生成 + 通过 MCP 协议暴露给 AI 助手 |
| `@faapi/next` | Next.js + faapi 集成,`/api/*` 走 faapi,其余走 Next.js |

## 集成 Next.js

```ts
export default {
  plugins: ['@faapi/next'],
} satisfies FaapiConfig;
```

`@faapi/next` 插件选项:

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `dev` | `process.env.NODE_ENV !== 'production'` | 开发模式 |
| `dir` | `'.'` | Next.js 项目目录 |
| `apiPrefix` | `'/api'` | faapi API 路径前缀(决定哪些请求走 faapi) |

启动用 `faapi` 主 CLI,自动加载插件。详见 [init.md](./init.md)。

## 自定义插件

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
