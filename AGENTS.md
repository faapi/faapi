# AGENTS.md

## 1. 项目定位

faapi 是一个 Node.js 框架，核心理念是"函数即接口"。

## 2. 开发模式

本项目使用 **DDD（Documentation-Driven Development）** 模式开发，流程为：**文档 → 测试 → 代码 → 通过**。

DDD 通用规范见 `.trae/skills/ddd/SKILL.md`。

## 3. 全局协作规则

- 全程使用中文沟通。
- 禁止编造信息；不确定时先查文件或先提问。
- 代码示例默认使用 TypeScript。
- 包管理器默认使用 pnpm。
- TypeScript 配置采用 `moduleResolution: Bundler`，本地相对导入路径不写后缀（如 `from './utils'`），由 tsc/tsx/tsup/esbuild 解析；第三方包导入正常使用包名。
- 不要跳过测试直接声明功能完成。

## 4. 文档体系

### 4.1 文档结构

```
DDD 文档（与代码同目录，单一来源）
  src/router/scanRoutes.md    ← 模块用途、场景、依赖
  src/router/scanRoutes.test.ts ← 行为定义
  src/router/scanRoutes.ts      ← 实现
  src/injection/README.md       ← 跨模块功能概述（目录级）

AGENTS.md                       ← 项目唯一顶层文档（本文件）
```

### 4.2 各文档职责

| 文档 | 职责 | 维护时机 |
| --- | --- | --- |
| `src/**/*.md` | DDD 文档：模块用途、为什么需要、使用场景、相关模块 | 新增/删除 `.ts` 模块时 |
| `src/**/README.md` | 跨模块功能概述（目录级） | 新增跨模块目录时 |
| `AGENTS.md` | 项目定位、架构、约定、交付定义 | 架构变更或里程碑完成时 |

### 4.3 核心原则：不重复

- **模块级信息**（用途、场景、依赖）只在 DDD `.md` 中维护。
- **跨模块信息**只在目录级 `README.md` 中维护。
- **项目级信息**（架构、约定、验收）只在 `AGENTS.md` 中维护。
- **DDD 通用规范**（流程、模板、检查清单）只在 `.trae/skills/ddd/SKILL.md` 中维护。
- 同一信息只在一处维护，其他地方引用。

## 5. 架构

### 5.1 层间关系

```
dev:   CLI → compileDevRoutes  → .faapi/        → createDevApp()        ─┐
build: CLI → compileBuildRoutes → dist/ + dist/main.js                  │
prod:  node dist/main → createProdApp() → dist/                          ┤→ Server → Router → Loader → Runtime → Response
                                                                       ↓                ↓
                                                                   Injection        Validator
                                                                       ↓                ↓
                                                                     AST            Middleware
```

dev 模式：`faapi dev` 编译 + 调 `createDevApp()` + watcher（调 `app.reloadRoutes()`）。
生产模式：`faapi build` 生成产物 + `dist/main.js` 启动入口，`node dist/main` 调 `createProdApp()` 自动水合路由清单。

框架采用零入口设计——用户无需编写 `main.ts`：dev 由 CLI 内部编排，prod 由 build 阶段生成 `dist/main.js` 启动入口。

### 5.2 包结构

```
@faapi/faapi           核心包：API 路由、中间件、注入、校验、AST 能力公开导出
@faapi/mcp             MCP Server SDK：纯手写 MCP 协议（Streamable HTTP transport），不依赖 @modelcontextprotocol/sdk
@faapi/schema          扩展包：路由 schema 生成 + 通过 MCP 协议暴露给 AI 助手（基于 @faapi/mcp）
```

`@faapi/mcp` 是独立的 MCP Server SDK，提供 `createMcpServer`（tool 注册 + JSON-RPC 分发）、`handleMcpRequest`（Streamable HTTP transport）、`createMcpHandler`/`createMcpNodeHandler`（faapi 适配器）等能力。仅依赖 zod（v4 内置 `toJSONSchema`，无需 zod-to-json-schema）。

`@faapi/schema` 为可选扩展，CLI 动态加载——未安装时自动跳过，不影响核心功能。基于 `@faapi/mcp` 实现，通过插件 `wrapHandler` 在 `/mcp` 路径挂载 MCP 端点，AI 助手通过 Streamable HTTP 连接。

主包公开 AST 能力（`createProgram`/`extractTypeInfo`/`collectRouteSchemaSources` 等），`@faapi/schema` 组合这些能力生成路由 schema，不依赖主包内部模块。

### 5.3 使用方式

参考 NestJS 模式：CLI 负责 `faapi dev`（编译 + watcher）和 `faapi build`（构建产物）。dev/prod 为两套独立代码路径，仅共享 `createAppBase` 编排核心和工具级函数，无 `if (isDev)` 分支：

- **dev**：`faapi dev` 调用 `createDevApp()`（含 `reloadRoutes` 热替换）
- **prod**：`faapi build` 生成 `dist/main.js` 启动入口（内部 import `createProdApp` + `listen`），`node dist/main` 直接启动

框架采用零入口设计——用户无需编写 `main.ts`：dev 由 CLI 内部编排，prod 由 build 阶段自动生成 `dist/main.js` 启动入口。用户自定义启动逻辑（初始化数据库、注册信号处理等）通过 `faapi.config.ts` 的 `lifecycle.onReady` / `onClose` 钩子实现，dev/prod 都执行。

```bash
# dev 模式（编译 .ts → .faapi/*.js + 生成产物三元组 + 调 createDevApp() 启动 dev 应用 + 启动 watcher）
faapi
faapi dev                      # 同上

# 生产模式
faapi build                    # 构建（逐文件编译（bundle: false） .ts → dist/*.js + 编译合并配置 → dist/faapi-config.js + 生成 dist/faapi-routes.js + 每个 handler 的 zod.js + 生成 dist/main.js 启动入口）
node dist/main         # 启动生产服务器（main.js 内部调 createProdApp 读 dist/ 产物三元组）
```

`createApp` / `createProdApp` / `createDevApp` 主要供编程式调用场景使用（如自定义启动器、测试场景），`dist/main.js` 内部也调用它们完成启动。

配置分两类：

- **应用行为配置**（CORS、lifecycle、middlewares、业务配置等）从 `faapi.config.ts` 读取
- **框架元信息**（port、dist）通过环境变量传入，不放在 config 内：
  - `PORT`：服务端口，默认 3000
  - `FAAPI_DIST`：产物输出目录，dev 固定为 `.faapi`（不可修改），prod 默认 `dist`（可通过 `--dist` 选项修改）。

```ts
// faapi.config.ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  cors: { origin: '*' },
  // 自定义业务配置（任意 key，通过 ctx.config 访问）
  db: { host: 'localhost', port: 5432 },
} satisfies FaapiConfig;
```

启动时通过环境变量传入框架元信息：

```bash
# dev 模式
PORT=3000 faapi dev

# prod 模式
PORT=8080 node dist/main
```

**统一产物驱动（无 dev/prod if 分支）**：

dev 和 prod 生成完全一致的产物三元组（`faapi-config.js` + `faapi-routes.js` + 各 handler 的 `zod.js`），`createAppBase`（dev/prod 共享编排核心）和 `loadConfig` 走完全相同的读产物代码路径，差异仅由 `FAAPI_DIST` 环境变量（路径参数 / 数据）驱动，不存在 `if (isDev)` 控制流分支。

| 产物 | dev 模式 | prod 模式 |
|------|---------|----------|
| `*.js`（路由/middleware/项目模块编译） | `.faapi/**/*.js` | `dist/**/*.js` |
| `faapi-config.js`（配置入口产物，import config 源产物 + 内联 deepMerge） | `.faapi/faapi-config.js` | `dist/faapi-config.js` |
| `faapi.config.js`（config 源编译产物，保留相对 import 指向项目模块） | `.faapi/faapi.config.js` | `dist/faapi.config.js` |
| `faapi-routes.js`（路由清单） | `.faapi/faapi-routes.js` | `dist/faapi-routes.js` |
| `zod.js`（schema 模块） | `.faapi/**/zod.js` | `dist/**/zod.js` |
| `faapi-helpers.js`（coerce 公用函数，仅有 number/boolean 字段时生成） | `.faapi/faapi-helpers.js` | `dist/faapi-helpers.js` |
| `main.js`（启动入口，仅 prod） | — | `dist/main.js` |

- `faapi` / `faapi dev`：dev 模式，`devCommand` 设 `FAAPI_DIST=.faapi`（dev 产物目录固定为 `.faapi`，不可修改），`compileDevRoutes` 逐文件编译 `.ts` → `.faapi/*.js`（`bundle: false`，启动快、增量编译），调 `compileConfig` 两步编译生成 `.faapi/faapi-config.js`（config 源 + 项目模块逐文件编译 + 入口 bundle external），调 `generateRouteArtifacts` 生成 `faapi-routes.js` + `zod.js`，调 `createDevApp()` + `listen()`（含 `reloadRoutes` 热替换能力），watch 文件变化（增量编译 + 重生成 `faapi-config.js` + 调 `app.reloadRoutes()` 热替换路由）
- `faapi build`：构建，`compileBuildRoutes` 逐文件编译（`bundle: false`，与 dev 一致，打平 src 前缀）→ `dist/*.js` + `compileConfig` 两步编译合并配置 → `dist/faapi-config.js` + 生成 `dist/faapi-routes.js` + 每个 handler 的 `zod.js` + 生成 `dist/main.js` 启动入口（零入口设计：内部 import `createProdApp` + `listen`），不启动服务器
- `node dist/main`：生产模式，直接运行 `dist/main.js`，`createProdApp()` 读 `FAAPI_DIST`（未设置时默认 `dist`），水合 `dist/faapi-routes.js` 路由清单，`loadConfig` 读 `dist/faapi-config.js`，运行时按需 import `zod.js` 做 zod safeParse

`FAAPI_DIST` 是路径参数而非模式标志——`createAppBase` 内部无 `if (isDev)` 分支，统一水合 `faapi-routes.js`、统一 `loadConfig(dist)` 读配置、统一按需 import `zod.js`。dev 的 `createDevApp` 在 `createAppBase` 基础上增加 `reloadRoutes`，prod 的 `createProdApp` 直接返回 `createAppBase` 结果。

**统一编译模式（dev/prod 一致，bundle: false 逐文件编译）**：

dev 和 build 都采用 `bundle: false` 逐文件编译，每个 `.ts` 独立编译为 `.js`，不分析 import 关系。差异仅由 `dist`（路径参数）驱动，编译逻辑完全一致。

- **为什么不用 bundle 模式**：bundle 模式（`bundle: true`）会把 import 的项目模块 inline 进产物，导致 `faapi.config.ts` 中的 `instanceof` 对项目自定义错误类失效——config 和 routes 各自打包出独立的项目类副本，运行时对象不同一。逐文件编译保证每个源文件对应唯一一份产物，config 和 routes 共享同一运行时对象，`instanceof` 跨边界生效。
- **`compileConfig` 两步编译**（确保 config 引用的项目模块与 routes 共享）：
  - 步骤 1：`bundle: false` 逐文件编译 config 源（`faapi.config.ts` + `faapi.config.{env}.ts`）+ 递归收集 config 引用的项目模块（按 src 内/外分别用 outbase 打平前缀），aliasPlugin 重写 specifier（相对路径加 `.js` 后缀；config 引用 src 内模块时剥离前缀，使 config 产物 import `./lib/errors.js` 而非 `./src/lib/errors.js`）
  - 步骤 2：`bundle: true` + 相对路径 external 编译入口源码（`import base from './faapi.config.js'` + 内联 `deepMerge` + `export default`），避免 inline config 产物，保留 `import './faapi.config.js'` 语句
- **`process.env.NODE_ENV` 处理**：build 模式用 `define: { 'process.env.NODE_ENV': '"production"' }` + `minifySyntax: true` 做死代码消除——编译期把 `process.env.NODE_ENV` 替换为 `"production"`，`minifySyntax` 删除 `if (false) {...}` 死分支（两者在 `bundle: false` 下均生效，单文件级别优化）。dev 模式不传 `define`，`process.env.NODE_ENV` 运行时读取环境变量（`devCommand` 兜底设 `'development'`），便于热替换时环境变化。

`NODE_ENV`/`FAAPI_ENV` 仅用于 `compileConfig` 选择环境配置文件（按 `FAAPI_ENV > NODE_ENV > 'development'` 优先级选择 `faapi.config.{env}.ts` 与基础配置深度合并到 `faapi-config.js`），不再用于运行时配置合并。

启动时按 mode 兜底设置 `NODE_ENV`（仅在未显式设置时，不覆盖用户意图）：`faapi`/`faapi dev` → `development`，`node dist/main` → 由用户自行设置。build 产物中 `process.env.NODE_ENV` 已被 `define` 编译期替换为 `"production"`（死代码消除）；dev 中运行时读取环境变量。如果业务配置中有运行时读取 `process.env.NODE_ENV` 的逻辑（如 `onReady` 钩子），需启动时显式设置或由部署环境注入。

CORS 等运行时配置通过 `faapi.config.ts` 配置；框架元信息（port/dist）通过环境变量传入。

### 5.4 接口文件示例

```ts
// api/user/handler.ts
export interface Query {
  page: number;
  pageSize: number;
}

export interface CreateUserBody {
  name: string;
  email: string;
}

export function GET(query: Query) {
  return { page: query.page, pageSize: query.pageSize };
}

export function POST(body: CreateUserBody) {
  return { created: true, name: body.name };
}
```

### 5.4 中间件示例

```ts
// api/admin/middlewares.ts
import type { FaapiMiddleware, InjectorMap } from '@faapi/faapi';

// 默认导出：中间件数组（洋葱模型，单一 async 函数）
export default [
  // 鉴权：无 token 拦截，有 token 塞 user 到 ctx
  async (ctx, next) => {
    const token = ctx.headers.get('authorization');
    if (!token) return new Response('Unauthorized', { status: 401 });
    ctx.user = { id: 1, name: 'admin' };
    await next();
  },
  // 日志：before/after 一体，闭包共享状态
  async (ctx, next) => {
    const start = Date.now();
    await next();
    console.log(`${ctx.method} ${ctx.path} ${Date.now() - start}ms`);
  },
  // 错误处理：try/catch 语义
  async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      console.error(`${ctx.method} ${ctx.path} error:`, err);
      return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
    }
  },
] satisfies FaapiMiddleware[];

// 命名导出 injectors：注入器映射表（按参数名匹配 handler 参数）
export const injectors: InjectorMap = {
  db: () => getDbConnection(),
  user: (ctx) => ctx.user, // 取中间件塞的值
};
```

### 5.5 配置文件（faapi.config.ts）

在项目根目录创建 `faapi.config.ts`，支持生命周期钩子、自定义业务配置、全局中间件等。

**统一响应格式与错误处理**:框架不内置统一响应包装/错误格式化配置(避免 handler 返回类型与实际响应类型断裂)。推荐业务方通过辅助函数 + 全局中间件模式实现:

```ts
// src/utils/response.ts(业务自定义辅助函数)
export function ok<T>(data: T) {
  return { code: 0, data, message: 'success' } as const;
}

// api/user/handler.ts(handler 直接返回完整结构,类型一致)
export interface User { id: number; name: string }
export function GET(): ReturnType<typeof ok<User>> {
  return ok({ id: 1, name: 'Alice' });
}

// faapi.config.ts(全局错误中间件捕获 handler 抛错)
import type { FaapiMiddleware } from '@faapi/faapi';
const errorHandler: FaapiMiddleware = async (ctx, next) => {
  try { await next(); } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.json({ code: 500, data: null, message }, 500);
  }
};
export default { middlewares: [errorHandler] } satisfies FaapiConfig;
```

完整配置示例:

```ts
// faapi.config.ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  // 生命周期钩子
  lifecycle: {
    async onReady({ rootDir, routes, server }) {
      // 初始化数据库连接、Redis 等
      console.log(`Server ready with ${routes.length} routes`);
    },
    async onClose({ rootDir, server }) {
      // 清理资源、优雅关闭
      console.log('Server shutting down');
    },
    // 请求错误已被处理为响应、响应发出后触发（参考 Fastify onError 语义）
    // 用于副作用：日志/告警/链路追踪，不修改已发出的响应；自身抛错被忽略
    // 错误兜底链：全局中间件 try/catch → 内置 formatErrorResponse 兜底 → 仍失败则最简 500
    onError(error, ctx) {
      console.error(`[onError] ${ctx.method} ${ctx.path}`, error);
    },
  },

  // 扩展 ctx：挂载自定义方法/属性，配合 declare module '@faapi/faapi' 增强 FaapiContext 类型
  extendContext(ctx) {
    ctx.t = (key: string) => key; // 示例：i18n
  },

  // CORS 配置
  cors: { origin: ['https://example.com'], credentials: true },

  // 全局中间件：对所有路由（HTTP + WebSocket 握手）生效，最外层
  // 顺序：CORS → helmet → logger → 全局 → 目录（根→路由）→ handler
  // CORS/logger 默认启用（config.cors/config.logger 配置），helmet 显式启用（config.helmet）
  middlewares: [
    async (ctx, next) => {
      ctx.requestId = crypto.randomUUID(); // 塞值，handler/目录中间件可读
      await next();
    },
  ],

  // 插件：应用级扩展，启动时初始化（如启动后台服务、注册协议）
  // 与中间件的区别：中间件拦截每个请求，插件在启动时 setup 一次
  plugins: [
    '@faapi/schema',                          // 包名
    ['@faapi/schema', { stdio: true }],        // 带选项
    { package: '@faapi/schema', enable: true }, // 完整声明
    { path: './my-plugin' },                    // 本地路径
  ],

  // 自定义业务配置（任意 key，通过 ctx.config 访问）
  db: { host: 'localhost', port: 5432 },
  redis: { host: '127.0.0.1', port: 6379 },
} satisfies FaapiConfig;
```

#### 5.5.1 多环境配置

支持按环境加载不同配置，环境由 `FAAPI_ENV` 或 `NODE_ENV` 决定（默认 `development`）。优先级 `FAAPI_ENV > NODE_ENV > 'development'`：

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

环境配置与基础配置**深度合并**，环境配置优先。

#### 5.5.2 自定义业务配置（ctx.config）

配置文件中的自定义 key 自动注入到每个请求的 `ctx.config`：

```ts
// faapi.config.ts
export default {
  db: { host: 'localhost', port: 5432 },
} satisfies FaapiConfig;

// api/user/handler.ts
export function GET(ctx) {
  const dbConfig = ctx.config.db; // { host: 'localhost', port: 5432 }
  return { dbHost: dbConfig.host };
}
```

#### 5.5.3 ctx 便捷方法

| 方法 | 说明 | 示例 |
|------|------|------|
| `ctx.json(data, status?)` | 返回 JSON 响应 | `return ctx.json({ error: 'Not found' }, 404)` |
| `ctx.html(html, status?)` | 返回 HTML 响应 | `return ctx.html('<h1>Hello</h1>')` |
| `ctx.redirect(url, status?)` | 返回重定向响应 | `return ctx.redirect('/login')` |
| `ctx.sse()` | 创建 SSE writer，流式推送事件 | `const sse = ctx.sse(); sse.send({data:'chunk'}); sse.close()` |

`ctx.sse()` 返回 `SseWriter`，handler 通过 `sse.send({ data, event?, id?, retry? })` 推送事件，`sse.close()` 关闭流。框架自动构造 `text/event-stream` Response，与 `ctx.json`/`ctx.html` 互斥。`SseWriter` 提供 `aborted` 属性检测客户端断开；handler 返回或抛错时框架自动 close 兜底，避免连接泄漏。详见 `src/runtime/sse.md`。

handler 返回值直接序列化为响应(原始数据);错误响应由内置 `formatErrorResponse` 兜底(参考 `src/errors/formatErrorResponse.ts`)。

### 5.6 设计决策

TypeScript 的 `interface` 在运行时会被擦除。第一版通过 TypeScript AST 分析类型声明，生成运行时校验规则，不以手写 schema 为主路径。

第一版先支持基础类型、对象类型、可选字段和数组类型；后续版本逐步扩展 AST 能力。

### 5.7 内置注入类型

| 参数名 | 注入内容 | 示例 |
|--------|---------|------|
| `query` | URL 查询参数对象 | `GET(query: Query)` |
| `body` | 请求体（JSON） | `POST(body: CreateUserBody)` |
| `form` | `application/x-www-form-urlencoded` 表单请求体（`Record<string, string>`，coerce=true，与 body 互斥） | `POST(form: LoginForm)` |
| `params` | 动态路由参数 | `GET(params: { id: string })` |
| `headers` | 请求头 Headers 对象 | `GET(headers)` |
| `context` / `ctx` | 完整请求上下文 | `GET(context)` |
| `cookies` | Cookie 对象 | `GET(cookies)` |
| `ip` | 客户端 IP（X-Forwarded-For 优先） | `GET(ip)` |
| `files` | 上传文件数组 | `POST(files)` |
| `fields` | Multipart 表单字段 | `POST(fields)` |

`form` 与 `body` 互斥：handler 声明其一即可。`form` 共享 `body` 的解析结果（`resolveInput` 已按 Content-Type 解析 form-urlencoded 为 `Record<string, string>`），差异仅在 schema 校验——`form` 的 schema coerce=true（与 query/params 一致，number/boolean 字段自动转换字符串），`body` 的 schema coerce=false。schema 名仍为 `POSTBody`（form 共享 body 的 schema key），通过 `RouteSchemaSource.coerce=true` 显式覆盖。

自定义业务配置通过 `ctx.config` 访问：`GET(ctx) { return ctx.config.db }`，不作为参数名注入。

### 5.8 中间件与注入器

中间件采用洋葱模型，单一 async 函数 `(ctx, next) => Promise<void | Response>`；注入器独立提供依赖，与中间件解耦。

**中间件行为**（通过 `await next()` 衔接）：

| 行为 | 时机 | 用途 |
|------|------|------|
| `await next()` 之前 | handler 执行前 | 日志、鉴权拦截 |
| `await next()` 之后 | handler 执行后 | 日志、响应修改 |
| 不调用 `next()` | 拦截请求 | 鉴权失败、限流 |
| `try/catch` 包裹 `next()` | 错误捕获 | 错误处理、日志 |

**注入器**（`middlewares.ts` 中 `export const injectors`）：

| 时机 | 用途 |
|------|------|
| handler 参数注入时（按需） | 依赖注入（db、user 等），可读取中间件塞进 ctx 的值 |

### 5.9 WebSocket 支持

faapi 通过 `ws` 库提供路由级 WebSocket 支持。在 `handler.ts` 中导出 `WS` 函数即声明 WS 路由，与 HTTP 方法导出（`GET`/`POST` 等）同级。

```ts
// api/chat/handler.ts
import type { WsContext, WsEventHandlers } from '@faapi/faapi';

export function WS(ctx: WsContext): WsEventHandlers {
  return {
    onOpen(ws) {
      ws.send('connected');
    },
    onMessage(ws, message) {
      ws.send(`echo: ${message}`);
    },
    onClose(ws, code, reason) {
      console.log('closed', code);
    },
    onError(ws, error) {
      console.error('ws error', error);
    },
  };
}
```

**路由匹配**：WS 路由无 HTTP 方法维度，按 URL pathname 匹配。动态路由 `[id]`、catch-all `[...slug]`、分组 `(name)` 同样适用。未匹配路径返回 404 并销毁 socket。

**WsContext**：握手阶段构造，包含 `params`/`query`/`headers`/`config`。可通过 `declare module '@faapi/faapi'` 增强自定义字段。

**WsSocket**：faapi 封装的 socket 抽象，不暴露 `ws` 库原生 socket：
- `send(data)` — string/Buffer 直发，对象自动 JSON.stringify
- `close(code?, reason?)` — 关闭连接
- `readyState` — 0=connecting, 1=open, 2=closing, 3=closed

**事件回调**：`onOpen`/`onMessage`/`onClose`/`onError` 均可选，未提供则忽略。连接建立后切到事件模型，不走洋葱中间件。

**与 SSE 互补**：SSE 适用于单向服务端推送（LLM 流式输出、通知）；WebSocket 适用于双向长连接（聊天室、协同编辑）。

> 注：WS 两阶段中间件策略——握手阶段（HTTP upgrade）复用洋葱中间件链，与同目录 HTTP 路由共享鉴权/CORS/限流；事件回调阶段不走中间件。详见 `src/runtime/wsHandler.md`。

## 6. 约定

### 6.1 文件命名

- 源码文件使用小驼峰：`scanRoutes.ts`、`matchRoute.ts`。
- 类型文件使用 `Types.ts` 后缀：`routeTypes.ts`、`configTypes.ts`。
- 测试文件使用 `.test.ts`，端到端测试使用 `.e2e.test.ts`。
- 路由根目录固定为 `src/`（参照 Next.js src 目录约定）：API 路由放在 `src/api/` 下。
- 用户路由文件统一使用 `handler.ts`，放在 `src/api/` 下，导出 HTTP 方法名（`GET`、`POST` 等）；导出 `WS` 函数即声明 WebSocket 路由（与 HTTP 方法同级）。
- 框架采用零入口设计——用户无需编写 `main.ts`：dev 由 `faapi dev` 内部编排（调 `createDevApp` + `listen`），prod 由 `faapi build` 自动生成 `dist/main.js` 启动入口（内部 import `createProdApp` + `listen`），`node dist/main` 直接启动。用户自定义启动逻辑通过 `faapi.config.ts` 的 `lifecycle.onReady` / `onClose` 钩子实现。`createApp` / `createProdApp` / `createDevApp` 主要供编程式调用场景使用（如自定义启动器、测试场景），`createApp` 为 `createProdApp` 的向后兼容别名。
- 中间件文件使用 `middlewares.ts`，导出默认数组。
- 动态路由目录使用 `[name]`：`[id]`。
- Catch-all 路由目录使用 `[...name]`：`[...slug]`。
- 路由分组目录使用 `(name)`：`(marketing)`，不影响 URL。

### 6.2 状态码

```txt
400 -> 请求语法错误：JSON 解析失败、必填字段缺失（INVALID_FORMAT / MISSING_FIELD）
404 -> 路由不存在
405 -> 方法不允许
422 -> 语义错误：类型不匹配、值不在允许范围、query 字符串转换失败（TYPE_MISMATCH / INVALID_VALUE / COERCE_FAILED）
500 -> 模块加载失败 / handler 未捕获异常
```

ValidationError 状态码按 issue.code 自动推导（多 issue 取最高严重度，400 优先）。

### 6.3 类型校验策略

- 类型校验主方案通过 TypeScript AST 提取 `RuntimeType`，再生成 zod schema 代码。
- 不把手写 schema 作为第一版主路径。
- 如遇 AST 暂不支持的语法，直接抛 `SchemaExtractionError`，不降级为 `any`（方便开发时改正）。
- 显式声明 `unknown` 表示不校验；`any`/`void`/`never`/`object` 均抛错。
- AST 提取 `RuntimeType` 结构化类型描述，再生成 zod schema JS 代码（`zod.js` 文件）：
  - 每个 handler 生成一个 `zod.js`，与 `handler.js` 同级（如 `dist/api/hello/zod.js`）。
  - dev：`devCommand` 启动时 + watch 时调 `generateSchemaFiles` 生成 `zod.js` 到 `.faapi/`。
  - prd：`faapi build` 调 `generateSchemaFiles` 生成 `zod.js` 到 `dist/`。
  - 运行时 `validateInput` 按 `route.filePath` 计算 `zod.js` 路径并 `import`，执行 zod `safeParse` 校验。
- 循环引用通过 zod 的 `z.lazy(() => ...)` 延迟求值处理。
- 跨文件类型引用：TypeScript checker 在 AST 提取阶段已解析为完整 `RuntimeType`（内联），每个 `zod.js` 自包含，无需跨文件 import。
- coerce 内联到 zod schema：query/params 来自 URL 值均为 string，类型转换（string→number/boolean）在代码生成阶段用 `z.preprocess` 内联到 schema，不再有独立的 `coerceInput` 步骤。
  - `generateZodSchemaSource` 新增 `coerce` 参数（默认 `false`），`true` 时为 number/boolean 字段（含嵌套元素）包 `z.preprocess`。
  - 公用函数提取到 dist 根部的 `faapi-helpers.js`（仅一份，ESM export `coerceNumber` / `coerceBoolean`），各 `zod.js` 通过相对路径 `import` 复用，而非每个文件内联声明；无 coerce schema 时不生成该文件，zod.js 也不注入 import。
  - `generateSchemaFileSource` 根据 schemaName 推断 inputType：以 `Query`/`Params` 结尾 → `coerce=true`；以 `Body` 结尾 → `coerce=false`（JSON 解析已是天然 JS 类型）。
  - `mapZodCode` 新增 `not_finite → COERCE_FAILED` 映射（实际场景中 coerce 失败多报 `invalid_type`）。
- dev 和 prd 行为一致，不降级：
  - dev：启动时全量 AST 提取并预生成 `zod.js`，watch 时增量编译 + 全量重建 schema + `invalidateSchemaCache()` 清空模块缓存。
  - prd：`faapi build` 生成 `zod.js`，启动时按需 import。
  - schema 缺失（`zod.js` 文件不存在或 import 失败）抛 `InternalError`，不静默放行。

### 6.4 技术栈

- TypeScript、Node.js ESM
- `esbuild` 编译路由文件与 `faapi.config.ts`、`tsup` 打包
- `cac` CLI、`fast-glob` 文件扫描、`chokidar` watch
- TypeScript Compiler API AST 分析
- `zod` 运行时参数校验（AST → RuntimeType → zod schema 代码生成）
- `ws` WebSocket 协议
- `vitest` 测试
- 代码质量：`eslint`（flat config）+ `prettier` + `husky` + `lint-staged` + `commitlint`
- 版本与发布：`@changesets/cli` + `@changesets/changelog-github`，CI 由 GitHub Actions 驱动

### 6.5 新增子包配置清单

新增 `@faapi/<name>` 子包时，按本清单逐项配置，确保与现有三个包一致并通过 Trusted Publisher（OIDC）发布。

#### 6.5.1 目录结构

```
packages/<name>/
├── src/
│   └── index.ts
├── LICENSE            # MIT，从其他包复制
├── README.md
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts
```

#### 6.5.2 `package.json` 必需字段

```json
{
  "name": "@faapi/<name>",
  "version": "0.0.0-canary.0",
  "description": "...",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": { "types": "./src/index.ts", "import": "./src/index.ts" }
  },
  "engines": { "node": ">=24" },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/faapi/faapi.git",
    "directory": "packages/<name>"
  },
  "bugs": { "url": "https://github.com/faapi/faapi/issues" },
  "keywords": [...],
  "sideEffects": false,
  "publishConfig": {
    "access": "public",
    "provenance": true,
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": {
      ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
    }
  }
}
```

要点：

- `version` 固定 `0.0.0-canary.0`，canary 阶段不递增（canary 版本由 CI 基于 git hash 生成）。
- `repository.directory` 指向 `packages/<name>`。
- `publishConfig.provenance: true` 必填，否则无法通过 Trusted Publisher 发布。
- 依赖主包时加 `"dependencies": { "@faapi/faapi": "workspace:*" }`。

#### 6.5.3 `tsconfig.json`（固定模板）

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

含 e2e 测试时加 `"exclude": ["src/**/*.e2e.test.ts"]`，避免 tsc 检查 e2e 深路径导入。

#### 6.5.4 `tsup.config.ts`

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  platform: 'node',
  external: ['node:*', '@faapi/faapi'],
});
```

`external` 至少包含 `node:*` 和 `@faapi/faapi`；有第三方 peer 依赖（如 `next`）一并加入。

#### 6.5.5 `vitest.config.ts`（依赖主包时需 alias）

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@faapi/faapi/src': path.resolve(__dirname, '../faapi/src'),
      '@faapi/faapi': path.resolve(__dirname, '../faapi/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 15000,
    fileParallelism: true,
    maxWorkers: '50%',
  },
});
```

E2E 测试含服务器启动时追加 `pool: 'forks'`（worker 线程易崩溃）。

#### 6.5.6 `.changeset/config.json` — 加入 fixed 数组

```json
"fixed": [["@faapi/faapi", "@faapi/schema", "@faapi/next", "@faapi/<name>"]]
```

fixed 模式强制所有包统一版本号，新增包必须加入此数组。

#### 6.5.7 新增 changeset

- 首次发布：创建 `.changeset/<name>-init.md`，frontmatter 声明 `"@faapi/<name>": major`。
- 日常用户可见变更：新增描述性 `.changeset/*.md`，声明对应版本类型（`major`/`minor`/`patch`）。
- canary 阶段不执行 `pnpm changeset version`，changeset 累积到首次正式发版时统一消费。

#### 6.5.8 无需修改的文件（已自动化）

| 文件 | 原因 |
|------|------|
| `pnpm-workspace.yaml` | 已用 `packages/*` 通配 |
| `eslint.config.js` | 全局 `**/*.ts` 覆盖 |
| `.github/workflows/ci.yml` | `pnpm -r run` 递归 |
| `.github/workflows/release.yml` | `pnpm -r publish` 递归 |

#### 6.5.9 npm 端手动配置（无法自动化）

每个新包需在 npm 网站单独配置 Trusted Publisher 记录：

- 包页面 → Settings → Publishing access → Trusted Publishers
- Repository owner：`faapi`
- Repository name：`faapi`
- Workflow filename：`.github/workflows/release.yml`
- Environment：留空

#### 6.5.10 验证

1. `pnpm install` —— 链接 workspace
2. `pnpm -r run typecheck` / `lint` / `test` / `build` —— 全部通过
3. push 到 main 触发 canary 发布，确认新包以 `0.0.0-canary.<hash>` 发布到 npm `canary` tag

## 7. 交付完成定义

某个子功能只有在以下条件全部满足时才算完成：

- DDD 文档存在。
- 测试存在且通过。
- 实现存在。
- 本文件已确认无需或已经同步更新。

发布相关补充约定：

- 对 `packages/faapi` 或 `packages/schema` 的用户可见变更必须添加 Changeset（`pnpm changeset`），随 PR 提交。
- CHANGELOG 由 Changesets 生成与维护，不手写。
- 提交信息遵循 Conventional Commits（由 commitlint 强制）。
- **Canary 发布**：push 到 main 自动发布 canary 包（版本号 `{version}-canary.{short_hash}`，npm tag `canary`）。
- **正式发布**：手动 `pnpm changeset version` 更新版本和 CHANGELOG → 提交 → 创建 `v*` tag → 推送 tag，自动发布正式包（npm tag `latest`）。
- 发版通过 npm Trusted Publisher（OIDC）自动完成，无需 `NPM_TOKEN` secret；workflow 需 `permissions: id-token: write`，发布命令带 `--provenance`。
