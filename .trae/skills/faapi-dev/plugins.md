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
  routes: RouteManifest;          // setup 时的快照，reloadRoutes 后不更新
  getRoutes: () => RouteManifest; // 获取最新路由（dev 模式 reloadRoutes 后用此取更新后的数组）
  server: Server;                  // 未 listen
  config: Record<string, unknown>; // 自定义业务配置（faapi.config.ts 中的自定义 key，不含 cors/middlewares 等内置 key）
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

插件在 server 创建后、listen 之前加载（`createAppBase` 函数体内顺序执行，无独立 `beforeListen` 钩子）。这确保插件能包装 handler,且包装后的 handler 在 server 开始处理请求前生效。

## routes vs getRoutes

- `ctx.routes` 是 **setup 时的快照**，dev 模式 `reloadRoutes` 热替换后**不会更新**。
- 需要感知路由变更的插件（如 dev 模式下重新生成路由 schema）应使用 `ctx.getRoutes()` 获取最新清单。

## 加载行为

- `enable: false` 的插件会被跳过（`loadPlugins.ts`）。
- 同名插件（按 specifier 去重）仅加载一次，重复声明会 warn。
- 插件 `setup` 不是函数时跳过并 warn。
- 插件加载失败（包不存在/import 失败）时 warn 但不抛错，不影响其他插件和主流程。

## 内置插件

| 包名 | 功能 |
|------|------|
| `@faapi/schema` | 路由 schema 生成 + 通过 MCP 协议暴露给 AI 助手 |
| `@faapi/next` | Next.js + faapi 集成,`/api/*` 走 faapi,其余走 Next.js |
| `@faapi/agent` | agent 子系统——注册 agent handle 工厂,handler 的 `agent` 参数注入可调用的 [AgentHandle](./agent.md)（LLM 驱动 ReAct 循环 + tool calling + sub-agent 递归） |

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

### 目录结构

faapi 与 Next.js 共存时,两个框架各自的目录约定需要并存:

```
project/
├── src/
│   ├── api/              ← faapi 路由(src/api/**/*.ts,固定扫描路径)
│   ├── app/              ← Next.js App Router(Next.js 自动检测 src/app/)
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   └── ...
│   ├── lib/              ← 后端共享代码(faapi handler 用)
│   └── db/               ← 后端数据库代码(faapi handler 用)
├── faapi.config.ts
├── next.config.ts
├── tsconfig.json
└── package.json
```

**关键点**:

- **faapi 固定扫描 `src/api/**/*.ts`**:把路由放在 `src/api/<path>/handler.ts`,faapi 自动发现
- **Next.js 自动检测 `src/app/`**:当 `src/` 目录存在时,Next.js 会把 `src/app/` 作为 App Router 目录(无需在 `next.config.ts` 中配置 `srcDir`)
- **`src/api/` 与 `src/app/` 不冲突**:faapi 只扫描 `src/api/**/*.ts`,不会扫描 `src/app/`;Next.js 只处理 `src/app/`,不会处理 `src/api/`
- **前端/后端共享代码分离**:前端共享代码放 `src/app/lib/`(或 `src/lib/` 但注意与后端共享区分),后端共享代码放 `src/lib/` 或 `src/db/`

`tsconfig.json` 需包含两端代码:

```json
{
  "include": [
    "src/api/**/*.ts",
    "src/lib/**/*.ts",
    "src/db/**/*.ts",
    "src/app/**/*.ts",
    "src/app/**/*.tsx",
    "faapi.config.ts",
    ".next/types/**/*.ts"
  ]
}
```

**为什么不用根目录 `app/`**:根目录 `app/` 与 `src/` 下放 faapi 路由会导致项目结构分裂(前端在根目录,后端在 `src/`),不利于维护。统一放在 `src/` 下更清晰。

## Next.js Server Component 同进程调用

在 Next.js Server Component（RSC）等"拿不到 faapi app 引用"的场景中,通过 `getApp()` 获取 app 单例,配合 `app.inject()` 同进程调用 faapi API,避免 HTTP loopback 开销:

```ts
// src/app/page.tsx(Next.js RSC)
import { getApp } from '@faapi/faapi';
import { headers } from 'next/headers';

async function Page() {
  const h = await headers();
  const app = getApp();  // 拿到 faapi 启动时创建的单例

  const res = await app.inject({
    method: 'GET',
    path: '/api/user',
    headers: {
      cookie: h.get('cookie') ?? '',               // 透传 cookie(鉴权/会话)
      authorization: h.get('authorization') ?? '', // 透传 token
    },
  });

  const data = res.body;  // 已解析,无需 await res.json()
  return <div>{data.name}</div>;
}
```

**关键点**:
- `getApp()` 未初始化时抛错(强约束,立刻发现问题);`createAppBase` 末尾设置单例,`close()` 时清 null
- `app.inject()` 走完整请求链路(CORS / helmet / logger / 全局中间件 / 路由匹配 / schema 校验 / 目录中间件 / handler),`listen()` 前后均可调用——`listen()` 后调用即用于 RSC 等同进程场景
- 返回 `{ status, headers, body }`——`body` 已 `JSON.parse`,无需手动 `await res.json()`
- 需手动透传请求头(cookie / authorization 等)从 `next/headers` 到 `inject` 的 `headers` 参数

## 启用 @faapi/agent（agent 子系统）

```ts
export default {
  agent: {
    // llms 嵌套级联：provider 在外层,model 挂在 models 下
    llms: {
      openai: {
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
        models: { 'gpt-4o': {}, 'gpt-4o-mini': { temperature: 0.5 } },
      },
    },
    defaultLlm: 'openai',
    defaultAgent: 'researcher',
    maxTurns: 10,
    maxAgentDepth: 3,
  },
  plugins: ['@faapi/agent'],
} satisfies FaapiConfig;
```

插件 setup 时：
1. 读 `config.agent.llms` → 遍历每项调 `createProvider` → 构建 `providers: Map<string, LLMProvider>`
2. 读 `config.agent.defaultLlm`（未设时取 `llms` 第一个 key）→ 默认 provider
3. 读 `config.agent.defaultAgent` / `maxTurns` / `maxAgentDepth`
4. 注册 agent handle 工厂——handler 的 `agent` 参数注入 `AgentHandle` 实例（含 `run` / `stream` / `asTool`，运行时 `options.model` 支持字符串 key 切换 provider/model）

`config.agent.llms` 或 `defaultAgent` 未配置时跳过工厂注册并 warn，`agent` 参数注入 `undefined`。

详见 [agent.md](./agent.md)。

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
