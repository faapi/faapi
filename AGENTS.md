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
CLI → Server → Router → Loader → Runtime → Response
                   ↓                ↓
               Injection        Validator
                   ↓                ↓
                 AST            Middleware
```

### 5.2 包结构

```
@faapi/faapi           核心包：API 路由、中间件、注入、校验、AST 能力公开导出
@faapi/schema          扩展包：路由 schema 生成 + 通过 MCP 协议暴露给 AI 助手
```

`@faapi/schema` 为可选扩展，CLI 动态加载——未安装时自动跳过，不影响核心功能。

主包公开 AST 能力（`createProgram`/`extractTypeInfo`/`getSchemaProperties` 等），`@faapi/schema` 组合这些能力生成路由 schema，不依赖主包内部模块。

### 5.3 使用方式

```bash
# 启动 dev server（默认扫描 api/**/*.ts）
faapi
faapi dev                      # 同上
faapi api/auth/*           # 指定路由 pattern
faapi --port 3000              # 指定端口
faapi --app-dir src        # 指定项目子目录（默认 .，即根目录）
faapi --static public          # 托管静态文件
faapi --no-cors                # 禁用 CORS
faapi --types faapi-types.ts    # 生成 RPC 类型文件
faapi --config faapi.config.ts  # 指定配置文件
faapi build                    # 构建
```

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

在项目根目录创建 `faapi.config.ts`，支持统一响应格式、全局错误处理、生命周期钩子、自定义业务配置等。

```ts
// faapi.config.ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  // 统一响应格式：handler 返回的对象自动包装
  responseFormat(data) {
    return { code: 0, data, message: 'success' };
  },

  // 全局错误格式：优先于内置 formatErrorResponse 处理错误
  // 返回 Response 表示已处理；返回 null/undefined 表示不处理，由内置 formatErrorResponse 兜底
  errorFormat(err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as any)?.statusCode ?? 500;
    return new Response(
      JSON.stringify({ code: status, data: null, message }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  },

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
    // 请求错误已被 errorFormat 处理为响应、响应发出后触发（参考 Fastify onError 语义）
    // 用于副作用：日志/告警/链路追踪，不修改已发出的响应；自身抛错被忽略
    // 错误兜底链：errorFormat 返回 null/未处理或抛错 → 内置 formatErrorResponse 兜底 → 仍失败则最简 500
    onError(error, ctx) {
      console.error(`[onError] ${ctx.method} ${ctx.path}`, error);
    },
  },

  // 扩展 ctx：挂载自定义方法/属性，配合 declare module '@faapi/faapi' 增强 FaapiContext 类型
  extendContext(ctx) {
    ctx.t = (key: string) => key; // 示例：i18n
  },

  // CORS 配置（覆盖 CLI 参数）
  cors: { origin: ['https://example.com'], credentials: true },

  // 全局中间件：对所有路由（HTTP + WebSocket 握手）生效，最外层
  // 顺序：CORS → 全局 → 目录（根→路由）→ handler
  middlewares: [
    async (ctx, next) => {
      ctx.requestId = crypto.randomUUID(); // 塞值，handler/目录中间件可读
      await next();
    },
  ],

  // 静态文件目录（覆盖 CLI 参数）
  staticDir: 'public',

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

支持按环境加载不同配置，环境由 `NODE_ENV` 或 `FAAPI_ENV` 决定（默认 `development`）：

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

`ctx.sse()` 返回 `SseWriter`，handler 通过 `sse.send({ data, event?, id?, retry? })` 推送事件，`sse.close()` 关闭流。框架自动构造 `text/event-stream` Response，与 `ctx.json`/`ctx.html` 互斥。`responseFormat` 不包装 SSE 响应。`SseWriter` 提供 `aborted` 属性检测客户端断开；handler 返回或抛错时框架自动 close 兜底，避免连接泄漏。详见 `src/runtime/sse.md`。

不配置时保持现有行为（直接返回原始数据、使用内置错误格式）。

### 5.6 设计决策

TypeScript 的 `interface` 在运行时会被擦除。第一版通过 TypeScript AST 分析类型声明，生成运行时校验规则，不以手写 schema 为主路径。

第一版先支持基础类型、对象类型、可选字段和数组类型；后续版本逐步扩展 AST 能力。

### 5.7 内置注入类型

| 参数名 | 注入内容 | 示例 |
|--------|---------|------|
| `query` | URL 查询参数对象 | `GET(query: Query)` |
| `body` | 请求体（JSON） | `POST(body: CreateUserBody)` |
| `params` | 动态路由参数 | `GET(params: { id: string })` |
| `headers` | 请求头 Headers 对象 | `GET(headers)` |
| `context` / `ctx` | 完整请求上下文 | `GET(context)` |
| `cookies` | Cookie 对象 | `GET(cookies)` |
| `files` | 上传文件数组 | `POST(files)` |
| `fields` | Multipart 表单字段 | `POST(fields)` |

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
- 路由根目录默认为项目根目录（可通过 `--app-dir` 指定子目录）：API 路由放在 `api/` 下。
- 用户路由文件统一使用 `handler.ts`，放在 `api/` 下，导出 HTTP 方法名（`GET`、`POST` 等）；导出 `WS` 函数即声明 WebSocket 路由（与 HTTP 方法同级）。
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

- 类型校验主方案通过 TypeScript AST 实现。
- 不把手写 schema 作为第一版主路径。
- 如遇 AST 暂不支持的语法，直接抛 `SchemaExtractionError`，不降级为 `any`（方便开发时改正）。
- 显式声明 `unknown` 表示不校验；`any`/`void`/`never`/`object` 均抛错。
- AST 提取 `RuntimeType` 结构化类型描述，再编译为校验函数 JS 代码：
  - dev：`new Function` 动态创建校验函数。
  - prd：`faapi build` 生成 `dist/faapi-schema.js`（ESM 模块），启动时 `import` 加载。
- 循环引用通过 JS 函数递归 + WeakSet 防无限递归处理。
- 跨文件类型引用（包括跨文件循环引用）：dev 和 prd 都先合并所有文件的类型为全局 `allTypes`，再生成校验函数，行为一致。
- dev 和 prd 都通过 `schemaRegistry` 获取 `{ properties, validator }`，不降级：
  - dev：启动时全量 AST 提取，watch 时全量重建（非增量，简单可靠，跨文件类型引用自然解决）。
  - prd：`faapi build` 生成 `dist/faapi-schema.js`，启动时加载。
  - schema 缺失（manifest 不完整）抛 `InternalError`，不静默放行。

### 6.4 技术栈

- TypeScript、Node.js ESM
- `tsx` 本地开发、`tsup` 打包
- `cac` CLI、`fast-glob` 文件扫描、`chokidar` watch
- TypeScript Compiler API AST 分析
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
