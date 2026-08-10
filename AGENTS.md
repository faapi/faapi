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
| `faapi-config.js`（配置入口产物，import config 源产物 + export base） | `.faapi/faapi-config.js` | `dist/faapi-config.js` |
| `faapi.config.js`（config 源编译产物，保留相对 import 指向项目模块） | `.faapi/faapi.config.js` | `dist/faapi.config.js` |
| `faapi-routes.js`（路由清单） | `.faapi/faapi-routes.js` | `dist/faapi-routes.js` |
| `zod.js`（schema 模块） | `.faapi/**/zod.js` | `dist/**/zod.js` |
| `faapi-helpers.js`（coerce 公用函数，仅有 number/boolean 字段时生成） | `.faapi/faapi-helpers.js` | `dist/faapi-helpers.js` |
| `main.js`（启动入口，仅 prod） | — | `dist/main.js` |

- `faapi` / `faapi dev`：dev 模式（**Vite 风格按需编译**），`devCommand` 先兜底 `NODE_ENV=development`（未显式设置时）+ `loadEnv(rootDir)` 加载 `.env` 系列文件到 `process.env`，设 `FAAPI_DIST=.faapi`（dev 产物目录固定为 `.faapi`，不可修改），启用按需编译模式（`setDevOnDemandEnabled(true)` + `setDevDist('.faapi')`），调 `compileConfig` 两步编译生成 `.faapi/faapi-config.js`（config 源 + 项目模块逐文件编译 + 入口 bundle external），调 `generateRouteArtifacts` 生成 `faapi-routes.js`（**仅路由清单，不预编译 handler.js，不预生成 zod.js**），调 `createDevApp()` + `listen()`（含 `reloadRoutes` 热替换能力），watch 文件变化（增量编译 + 重生成 `faapi-config.js` + 调 `app.reloadRoutes()` 热替换路由）。handler.js / zod.js 在首次请求时按需编译/生成（详见 `src/cli/compileOnDemand.md`）
- `faapi build`：构建，`compileBuildRoutes` 逐文件编译（`bundle: false`，与 dev 一致，打平 src 前缀）→ `dist/*.js` + `compileConfig` 两步编译配置 → `dist/faapi-config.js` + 生成 `dist/faapi-routes.js` + 每个 handler 的 `zod.js` + 生成 `dist/main.js` 启动入口（零入口设计：内部 import `createProdApp` + `loadEnv` + 兜底 `NODE_ENV` + `listen`），不启动服务器
- `node dist/main`：生产模式，直接运行 `dist/main.js`，先兜底 `NODE_ENV=production`（未显式设置时）+ `loadEnv(cwd)` 加载 `.env` 系列文件到 `process.env`，`createProdApp()` 读 `FAAPI_DIST`（未设置时默认 `dist`），水合 `dist/faapi-routes.js` 路由清单，`loadConfig` 读 `dist/faapi-config.js`，运行时按需 import `zod.js` 做 zod safeParse

`FAAPI_DIST` 是路径参数而非模式标志——`createAppBase` 内部无 `if (isDev)` 分支，统一水合 `faapi-routes.js`、统一 `loadConfig(dist)` 读配置、统一按需 import `zod.js`。dev 的 `createDevApp` 在 `createAppBase` 基础上增加 `reloadRoutes`，prod 的 `createProdApp` 直接返回 `createAppBase` 结果。

**统一编译模式（dev/prod 一致，bundle: false 逐文件编译）**：

dev 和 build 都采用 `bundle: false` 逐文件编译，每个 `.ts` 独立编译为 `.js`，不分析 import 关系。差异仅由 `dist`（路径参数）驱动，编译逻辑完全一致。

- **为什么不用 bundle 模式**：bundle 模式（`bundle: true`）会把 import 的项目模块 inline 进产物，导致 `faapi.config.ts` 中的 `instanceof` 对项目自定义错误类失效——config 和 routes 各自打包出独立的项目类副本，运行时对象不同一。逐文件编译保证每个源文件对应唯一一份产物，config 和 routes 共享同一运行时对象，`instanceof` 跨边界生效。
- **`compileConfig` 两步编译**（确保 config 引用的项目模块与 routes 共享）：
  - 步骤 1：`bundle: false` 逐文件编译 config 源（`faapi.config.ts`）+ 递归收集 config 引用的项目模块（按 src 内/外分别用 outbase 打平前缀），aliasPlugin 重写 specifier（相对路径加 `.js` 后缀；config 引用 src 内模块时剥离前缀，使 config 产物 import `./lib/errors.js` 而非 `./src/lib/errors.js`）
  - 步骤 2：`bundle: true` + 相对路径 external 编译入口源码（`import base from './faapi.config.js'` + `export default base`），避免 inline config 产物，保留 `import './faapi.config.js'` 语句
- **`process.env.NODE_ENV` 处理**：build 模式用 `define: { 'process.env.NODE_ENV': '"production"' }` + `minifySyntax: true` 做死代码消除——编译期把 `process.env.NODE_ENV` 替换为 `"production"`，`minifySyntax` 删除 `if (false) {...}` 死分支（两者在 `bundle: false` 下均生效，单文件级别优化）。dev 模式不传 `define`，`process.env.NODE_ENV` 运行时读取环境变量（`devCommand` 兜底设 `'development'`），便于热替换时环境变化。

`NODE_ENV` 用于 `loadEnv` 选择 `.env.{env}` 文件（按 `NODE_ENV || 'development'` 决定）。调用方在调 `loadEnv` 之前自行兜底 `NODE_ENV`：dev 设 `development`，prod 设 `production`。环境变量注入 `process.env` 供 `faapi.config.ts` 通过 `process.env.XXX` 读取。多环境差异通过 `.env` 系列文件实现。

启动时按 mode 兜底设置 `NODE_ENV`（仅在未显式设置时，不覆盖用户意图）：`faapi`/`faapi dev` → `development`，`node dist/main` → `production`（由 `main.js` 入口兜底）。build 产物中源码内的 `process.env.NODE_ENV` 已被 `define` 编译期替换为 `"production"`（死代码消除）；dev 中运行时读取环境变量。如果业务配置中有运行时读取 `process.env.NODE_ENV` 的逻辑（如 `onReady` 钩子），需启动时显式设置或由部署环境注入。

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

**统一响应格式与错误处理**：框架内置自动响应包装（`config.response` 配置），handler `return` 普通值时自动用 `ok` 函数包裹（默认 `{ data: T }`），错误用 `ctx.fail()` 返回（默认 `{ error: { message, ...code? } }`）。响应格式参考业界通用做法（Stripe / Facebook Graph / JSON:API）。

**`error.code` 是业务错误码（字符串），与 HTTP status 是两个独立维度，无关联**——HTTP status 表达错误大类（4xx/5xx），`code` 定位具体业务错误（如 `'USER_NOT_FOUND'`）。两者互补不冗余，但不存在推导关系：`ctx.fail()` 的 `status` 和 `code` 均可独立省略。

```ts
// api/user/handler.ts
// 1. 成功响应:直接 return 业务数据,框架自动用 config.response.ok 包裹(默认 { data })
export interface User { id: number; name: string }
export function GET(): User {
  return { id: 1, name: 'Alice' };
  // 响应: { data: { id: 1, name: 'Alice' } }
}

// 2. 错误响应:用 ctx.fail({ status?, code?, message }) 返回(对象形式,status 和 code 均可省略)
export function POST(ctx, body) {
  if (!body.name) {
    return ctx.fail({ status: 400, code: 'NAME_REQUIRED', message: 'name is required' });
    // 响应: HTTP 400, { error: { code: 'NAME_REQUIRED', message: 'name is required' } }
  }
  if (!isUnique(body.name)) {
    return ctx.fail({ status: 409, code: 'USER_NAME_DUPLICATED', message: '用户名已存在' });
    // 响应: HTTP 409, { error: { code: 'USER_NAME_DUPLICATED', message: '用户名已存在' } }
  }
  return { created: true };
}

// faapi.config.ts(全局错误中间件捕获 handler 抛错)
import type { FaapiMiddleware } from '@faapi/faapi';
import { ValidationError } from '@faapi/faapi';
const errorHandler: FaapiMiddleware = async (ctx, next) => {
  try { await next(); } catch (err) {
    if (err instanceof ValidationError) {
      return ctx.fail({
        status: err.statusCode,
        code: err.code,            // 框架字符串错误码
        message: err.message,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return ctx.fail({ message });  // status 省略默认 500,code 省略 body 里无 code 字段
  }
};
export default { middlewares: [errorHandler] } satisfies FaapiConfig;
```

**自动包裹规则**（`invokeHandler.wrapResult`）：

| handler 返回值 | 处理 |
| --- | --- |
| `Response` 对象 | 原样透传（`ctx.ok`/`ctx.fail`/`ctx.json` 等返回的 Response 不被再次包裹） |
| 其他值（含 `null`/`undefined`） | 用 `config.response.ok` 包裹（默认 `(data) => ({ data })`） |

`null`/`undefined` 也会被包裹为 `{ data: null }` / `{ data: undefined }`（后者 JSON 序列化后为 `{}`），不再返回 204 No Content。如需 204，handler 应显式返回 Response 对象（如 `return new Response(null, { status: 204 })`）。

`ctx.ok(data)` 显式包裹等价于 `return data`（框架自动包裹），两者响应一致。`ctx.fail()` 返回的是 `Response` 对象，不会被再次包裹。

**`ctx.fail()` 的 `status` 和 `code` 独立可省略**：

| 调用形式 | HTTP 状态码 | 响应 body |
| --- | --- | --- |
| `ctx.fail({ message })` | 500（默认） | `{ error: { message } }`（无 code 字段） |
| `ctx.fail({ status: 404, message })` | 404 | `{ error: { message } }`（无 code 字段） |
| `ctx.fail({ code: 'USER_NOT_FOUND', message })` | 500（默认） | `{ error: { code: 'USER_NOT_FOUND', message } }` |
| `ctx.fail({ status: 404, code: 'USER_NOT_FOUND', message })` | 404 | `{ error: { code: 'USER_NOT_FOUND', message } }` |

> `status` 省略时 HTTP 状态码默认 500；`code` 省略时响应 body 里不含 `code` 字段。两者无推导关系，独立控制。

**自定义包装结构**（`config.response`，可选）：

```ts
import type { FaapiConfig } from '@faapi/faapi';
export default {
  response: {
    // 自定义成功包装(默认 (data) => ({ data }))
    ok: (data) => ({ code: 0, data }),
    // 自定义错误包装(默认:省略的字段不放入 error 对象)
    fail: ({ status, code, message }) => ({ error: { code, message } }),
  },
} satisfies FaapiConfig;
```

`config.response` 的 `ok` / `fail` 字段均可选，按需覆盖；未配置时用框架默认实现。详见 `src/config/configTypes.md`。

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

  // 统一响应包装（可选，未配置时用框架默认 { data } / { error: { message, ...code? } }）
  response: {
    // ok: (data) => ({ data }),                  // 默认,可省略
    // fail: ({ status, code, message }) => ({ error: { message, ...code? } }), // 默认,可省略
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

多环境差异通过 `.env` 系列文件实现（参考 Next.js）。`faapi dev` / `node dist/main` 启动时调用 `loadEnv`（见 [src/cli/loadEnv.md](packages/faapi/src/cli/loadEnv.md)）按以下顺序加载到 `process.env`，`faapi.config.ts` 和 handler 通过 `process.env.XXX` 读取。

**env 决定规则**：`NODE_ENV || 'development'`。调用方在调 `loadEnv` 之前自行兜底 `NODE_ENV`：dev 设 `development`，prod 设 `production`。

**文件加载顺序**（从低到高优先级，后者覆盖前者）：

1. `.env` — 所有环境共享
2. `.env.local` — 本地覆盖（不提交 git）
3. `.env.{env}` — 按环境覆盖（如 `.env.production`）
4. `.env.{env}.local` — 按环境本地覆盖（不提交 git）

**shell 已设置的变量不被覆盖**（`export DB_HOST=xxx && faapi dev` 时 `.env` 中的 `DB_HOST` 不生效）。

```bash
# .env — 所有环境共享
DB_HOST=localhost
DB_PORT=5432

# .env.production — 生产环境覆盖
DB_HOST=db.production.com
```

```ts
// faapi.config.ts — 通过 process.env 读取
import type { FaapiConfig } from '@faapi/faapi';

export default {
  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? '5432'),
  },
} satisfies FaapiConfig;
```

`.env` / `.env.local` / `.env.*.local` 已在 `.gitignore` 忽略（`.env.{env}` 如 `.env.production` 可提交以共享环境配置）。dev 模式不 watch `.env` 文件变化（环境变量变更需重启服务，与 Next.js 行为一致）。

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
| `ctx.ok(data)` | 显式包裹成功响应（等价于 `return data`，框架自动包裹） | `return ctx.ok({ id: 1 })` |
| `ctx.fail({ status, code?, message })` | 返回错误响应（对象形式，`code` 可缺省按 `status` 推导） | `return ctx.fail({ status: 404, message: '用户不存在' })` |
| `ctx.json(data, status?)` | 返回 JSON 响应（不包裹，原样序列化） | `return ctx.json({ error: 'Not found' }, 404)` |
| `ctx.html(html, status?)` | 返回 HTML 响应 | `return ctx.html('<h1>Hello</h1>')` |
| `ctx.redirect(url, status?)` | 返回重定向响应 | `return ctx.redirect('/login')` |
| `ctx.sse()` | 创建 SSE writer，流式推送事件 | `const sse = ctx.sse(); sse.send({data:'chunk'}); sse.close()` |

`ctx.ok(data)` 和 `ctx.fail(...)` 返回的是 `Response` 对象，不会被自动包裹再次包装。handler 直接 `return` 普通值时框架自动用 `config.response.ok` 包裹（默认 `{ data }`），与 `return ctx.ok(data)` 响应一致。

`ctx.sse()` 返回 `SseWriter`，handler 通过 `sse.send({ data, event?, id?, retry? })` 推送事件，`sse.close()` 关闭流。框架自动构造 `text/event-stream` Response，与 `ctx.json`/`ctx.html` 互斥。`SseWriter` 提供 `aborted` 属性检测客户端断开；handler 返回或抛错时框架自动 close 兜底，避免连接泄漏。详见 `src/runtime/sse.md`。

handler 抛错时由内置 `formatErrorResponse` 兜底（参考 `src/errors/formatErrorResponse.ts`）；建议业务方在全局中间件中用 `try/catch` 捕获并通过 `ctx.fail()` 返回业务化错误响应。

### 5.6 设计决策

TypeScript 的 `interface` 在运行时会被擦除。第一版通过 TypeScript AST 分析类型声明，生成运行时校验规则，不以手写 schema 为主路径。

第一版先支持基础类型、对象类型、可选字段和数组类型；后续版本逐步扩展 AST 能力。

#### 5.6.1 Vite 风格按需编译（dev 模式）

dev 模式采用 Vite 风格按需编译——启动时只编译 config + 生成路由清单，handler.js / zod.js 在首次请求时才触发编译/生成，配合 mtime 缓存复用未变更的产物。详见 `src/cli/compileOnDemand.md`。

| 阶段 | 触发时机 | 行为 |
|------|---------|------|
| 启动 | `faapi dev` | 编译 config + 生成 `faapi-routes.js`（scanRoutes 仅读源码 + 正则提取方法名，零 import） |
| 首次请求 | `loadRouteModule` import 失败 | `ensureCompiled` 单文件编译 handler.js → 重试 import |
| 首次请求 | `createServer` 在 `validateInput` 之前 | `ensureSchemaGenerated` 单文件生成 zod.js |
| watcher 文件变化 | `reloadRoutes` | 删 stale zod.js + 清缓存（`clearCompiledFiles` / `clearGeneratedSchemas` / `invalidateMiddlewareCache`），下次请求按需重建 |

**三层 mtime 缓存**（`ensureCompiled` / `ensureSchemaGenerated` 共用策略）：

1. 内存 Set 命中 → 跳过（最快路径）
2. 产物存在且 mtime ≥ 源码 mtime → 加入 Set 跳过（复用 watcher 已编译的产物）
3. 产物不存在或 stale → 编译/生成 → 加入 Set

**与 prod 模式的差异**：prod 模式（`node dist/main`）不启用按需编译——`faapi build` 阶段已固化全部产物，import 失败即报错。`isDevOnDemandEnabled()` 是全局开关，prod 始终为 `false`。

#### 5.6.2 中间件按需加载（dev/prod 通用）

中间件模块（`middlewares.js`）的加载延后到首次请求阶段，dev 和 prod 都适用（与 handler.js / zod.js 的按需编译同源思想）。

- **scanRoutes**（dev）/ **serializeRoutes**（build）：只收集 `middlewarePaths`（中间件文件绝对路径列表，根在前、路由目录在后），不 import 任何中间件模块。
- **hydrateRoutes**（prod 启动）：把 `middlewarePaths` 存到 `RouteRecord` 上，不预加载中间件。
- **createServer** / **handleWsUpgrade**（首次请求）：`route.middlewares` 为 `undefined` 时调 `loadMergedMiddlewares(route.middlewarePaths)` 加载并合并，结果缓存到 `route.middlewares` / `route.injectors`，后续请求直接复用。
- **reloadRoutes**（watcher 热替换）：调 `invalidateMiddlewareCache()` 清缓存，下次请求重新加载。

`loadMergedMiddlewares` 单文件加载带缓存（`getCachedMiddlewares` / `setCachedMiddlewares`），多文件合并语义：子级中间件追加在父级之后（洋葱模型内层），子级注入器覆盖父级同名注入器。

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
| `ua` | 客户端 User-Agent（请求头 `user-agent` 原值，createContext 内联读取） | `GET(ua)` |
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

### 5.10 业务方测试支持

框架通过 `@faapi/faapi/testing` 子路径导出 `createTestContext` / `invokeHandler`，业务方可在不启动 HTTP 服务器、不依赖 build 产物的前提下，走框架真实的注入、中间件、序列化逻辑测试 handler。测试 API 与主入口 `@faapi/faapi` 分离，便于生产代码与测试代码导入分离。

```ts
import { createTestContext, invokeHandler } from '@faapi/faapi/testing';
import { GET } from './handler';

it('GET 返回分页数据', async () => {
  const ctx = createTestContext({
    path: '/api/user',
    query: { page: 1, pageSize: 10 },  // 对象形式，无需手写 URL
    config: { db: { host: '...' } },
  });
  const res = await invokeHandler(GET, ctx);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ page: '1', pageSize: '10' });
});
```

`createTestContext(options)` 是测试入口，接受 `{ method?, path, query?, headers?, params?, config?, ip? }` 对象，免去手写 `new Request('http://localhost/...')` 的样板代码。

`invokeHandler(handler, ctx, body?, middlewares?, injectors?)` 支持传入中间件链和注入器，可测试鉴权拦截、依赖注入等场景。不走 schema 校验（zod.js 由 build 生成）；如需测试完整请求链路（含 schema、全局中间件），用 `createProdApp` + `app.inject()`（需先 `faapi build`）。

详见 `src/testing.md`。

#### Next.js Server Component 同进程调用（getApp + app.inject）

业务方在 Next.js Server Component 等"拿不到 faapi app 引用"的场景中，可通过 `getApp()` 获取 app 单例，配合 `app.inject()` 同进程调用 faapi API（避免 HTTP loopback）：

```ts
// app/page.tsx（Next.js RSC）
import { getApp } from '@faapi/faapi';
import { headers } from 'next/headers';

async function Page() {
  const h = await headers();
  const app = getApp();  // 拿到 faapi 启动时创建的单例

  const res = await app.inject({
    method: 'GET',
    path: '/api/user',
    headers: {
      cookie: h.get('cookie') ?? '',               // 透传 cookie（鉴权/会话）
      authorization: h.get('authorization') ?? '', // 透传 token
    },
  });

  const data = res.body;  // 已解析，无需 await res.json()
  return <div>{data.name}</div>;
}
```

**关键点**：
- `getApp()` 未初始化时抛错（强约束）；`createAppBase` 末尾设置单例，`close()` 时清 null
- `app.inject()` 走完整请求链路（CORS / helmet / logger / 全局中间件 / 路由匹配 / schema 校验 / 目录中间件 / handler），`listen()` 前后均可调用
- 返回 `{ status, headers, body }`——`body` 已 JSON.parse，无需手动 `await res.json()`
- 需手动透传请求头（cookie / authorization 等）从 `next/headers` 到 `inject` 的 `headers` 参数

详见 `src/cli/createAppCore.md`。

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
  - dev（Vite 风格按需模式）：启动时仅编译 config + 生成路由清单，**不预生成 `zod.js`**；首次请求时 `ensureSchemaGenerated` 按需生成（mtime 缓存复用未变更的产物），watch 时删 stale zod.js + 清缓存 + 下次请求按需重建。
  - prd：`faapi build` 全量生成 `zod.js`，启动时按需 import。
  - schema 缺失（`zod.js` 文件不存在或 import 失败）抛 `InternalError`，不静默放行。

### 6.4 技术栈

- TypeScript、Node.js ESM
- `esbuild` 编译路由文件与 `faapi.config.ts`、`tsup` 打包
- `cac` CLI、`fast-glob` 文件扫描、`chokidar` watch
- TypeScript Compiler API AST 分析
- `zod` 运行时参数校验（AST → RuntimeType → zod schema 代码生成）—— peerDependency，业务方需自行安装 `zod@^4`（框架生成的 `zod.js` 在业务方项目目录执行，需项目根 `node_modules` 可解析到 zod）
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
- 依赖主包时声明为 `peerDependencies`（非 `dependencies`），同时 `devDependencies` 加 `workspace:*` 用于本地开发：`"peerDependencies": { "@faapi/faapi": "workspace:^" }` + `"devDependencies": { "@faapi/faapi": "workspace:*" }`。peerDependencies 用 `workspace:^`（发布时替换为 `^version`），使 minor/patch bump 不触发 changeset 的 peerDependent major bump；devDependencies 用 `workspace:*`（仅本地开发，不影响 changeset 计算）。
- `.changeset/config.json` 必须设置 `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange: true`，配合 peerDependencies 的 `workspace:^`，避免 changeset 在 minor/patch changeset 时错误地将 peerDependent 包 major bump（fixed 模式下会连锁升级所有包到 major）。
- 运行时 import 的依赖（如 `zod`）声明为 `peerDependencies`，业务方需自行安装；`devDependencies` 同步加一份用于本地测试。

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

`external` 至少包含 `node:*` 和 `@faapi/faapi`；运行时 import 的 peer 依赖（如 `next`、`zod`）一并加入，避免被 inline 进产物。

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
- **Canary 发布**：手动创建并推送 `v{version}-canary.N` 形式的 tag（如 `v1.2.3-canary.0`），CI 自动发布 canary 包（版本号取自 tag，npm tag `canary`）。
- **正式发布**：手动 `pnpm changeset version` 更新版本和 CHANGELOG → 提交 → 创建 `v{version}` tag（不含 `-canary` 后缀）→ 推送 tag，CI 自动发布正式包（npm tag `latest`）。
- 发版通过 npm Trusted Publisher（OIDC）自动完成，无需 `NPM_TOKEN` secret；workflow 需 `permissions: id-token: write`，发布命令带 `--provenance`。
