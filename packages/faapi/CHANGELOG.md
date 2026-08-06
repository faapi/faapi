# @faapi/faapi

## 1.4.0

## 1.3.1

### Patch Changes

- 补充 invokeHandler 的 ctx.ok / ctx.fail 单元测试覆盖：自动包裹、与 return data 一致性、Response 不被再次包裹、合并 setStatus/setHeader、自定义 config.response.ok/fail、status 与 code 独立可省略（无推导关系）、中间件组合（放行/拦截/try-catch 后用 ctx.fail）。同步 faapi-dev 技能 testing.md：局限性表新增"不走 formatErrorResponse 兜底"行，并说明 handler 抛错时 re-throw 的设计原因（invokeHandler 接收函数而非 route，无法定位 zod.js）。

## 1.3.0

### Minor Changes

- 新增统一响应包装能力：ctx.ok / ctx.fail 便捷方法 + handler 返回值自动包裹

  - 新增 `ctx.ok(data)`：显式包裹成功响应，等价于 `return data`（框架自动包裹）
  - 新增 `ctx.fail({ status?, code?, message })`：返回错误响应，status 和 code 均可独立省略（无推导关系）
  - 新增 `config.response` 配置（`ok` / `fail` 可选）：自定义成功/错误响应包装结构
  - `invokeHandler.wrapResult` 自动包裹：handler return 非 Response 的值（含 null/undefined）时用 `config.response.ok`（默认 `(data) => ({ data })`）包裹
  - `Response` 对象原样透传，不被包裹（`ctx.ok`/`ctx.fail`/`ctx.json` 等返回的 Response 均属此类）

  **Breaking**：handler `return data` 的默认响应格式从原样返回变为 `{ data }` 包裹。如需原样返回，用 `return ctx.json(data)`。

## 1.2.1

### Patch Changes

- 修复 server 未 listen 时调用 app.close() 报 ERR_SERVER_NOT_RUNNING 的问题；修复 dev 按需编译在 vitest/CI 环境下首次 import 失败导致 500 的问题（改为先 ensureCompiled 编译再 import）。

## 1.2.0

### Minor Changes

- Vite 风格按需编译与中间件按需加载

  - dev 模式启动时只编译 config + 生成路由清单，handler.js / zod.js 在首次请求时才触发编译/生成（三层 mtime 缓存复用未变更产物）
  - scanRoutes 改为正则提取方法名（零 import handler.js），中间件改为收集路径不预加载
  - 中间件加载延后到首次请求阶段（dev/prod 通用），hydrateRoutes 只传递 middlewarePaths，createServer / handleWsUpgrade 按需调用 loadMergedMiddlewares
  - watcher 热替换时清缓存（clearCompiledFiles / clearGeneratedSchemas / invalidateMiddlewareCache），下次请求按需重建
  - ensureCompiled / ensureSchemaGenerated 失败时抛错（不静默吞错），loadRouteModule 捕获并附加上下文

## 1.1.1

### Patch Changes

- 改进发布流程：通过 tag 区分 canary 和 stable 发布

## 1.1.0

### Minor Changes

- 853a175: 新增 `ua` 注入类型：handler 可通过 `ua` 参数名注入客户端 User-Agent（请求头 `user-agent` 原值），`ctx.ua` 字段可直接访问。与 `ip` 对称，UA 在 `createContext` 内联从请求头读取（无需调用方传入），HTTP 与 WebSocket 握手均自动支持。

## 1.0.2

### Patch Changes

- `createTestServer` 在 vitest 环境下自动走 Vite SSR pipeline，识别 TypeScript paths 别名 + 让 `vi.mock` 生效。

  ## 问题

  业务方在 vitest 下用 `createTestServer` 启动 in-memory 测试服务器时，handler 内 `import { db } from '@/lib/db'` 报 `Cannot find package '@/lib'`——`createTestServer` 内部 `importWithCacheBust` 用 Node 原生 `import()` 加载 handler，Node 原生 ESM 不识别 tsconfig paths 别名，也不让 `vi.mock` 生效（mock 只在 Vite module pipeline 内有效）。

  ## 修复

  `importWithCacheBust` 检测 `globalThis.vi.importActual`（vitest `globals: true` 时注入），优先走 Vite SSR pipeline：
  - 识别 `vitest.config.ts` 的 `resolve.alias` 与 tsconfig paths 别名
  - 让 `vi.mock` 在加载的 handler 内生效

  非 vitest 环境回退到 Node 原生 `import()`，无副作用。

  ## 业务方前置

  `vitest.config.ts` 设 `test.globals: true`（推荐），或测试文件内显式 `import { vi } from 'vitest'` 后挂到 `globalThis.vi`。

## 1.0.1

### Patch Changes

- 新增 E2E 测试 API：公开导出 `createTestServer` / `connectWs` / `MessageQueue` / `waitForWsOpen`，业务方一行代码启动带 schema 校验的真实端口测试服务器，并便捷测试 WebSocket 路由。

  - `createTestServer(options)`：内部自动 scanRoutes + mkdtemp + generateSchemaFiles + createServer + listen(0)；`close()` 自动 closeAllConnections + 清理 schema 目录 + invalidateSchemaCache
  - `connectWs(baseUrl, pathname, options?)`：解决 WS 测试三大痛点——open/message 监听竞态、三事件监听 + 超时清理、http→ws 协议转换；失败时主动 `ws.close()` 避免资源泄漏
  - `MessageQueue`：FIFO 缓冲早到消息 + Promise 化 `next(timeout)`；支持 Buffer/Buffer[]/ArrayBuffer 多种消息形态
  - `waitForWsOpen(ws, timeout?)`：Promise 化等待 `open` 事件，监听 open/error/close 并清理

  默认禁用 CORS/Helmet/Logger 避免污染断言；与 `createProdApp + app.inject` 互补——`createTestServer` 专注"真实端口 + 自动 schema"，无需 `faapi build` 即可测试 SSE/WS/CORS/真实 HTTP 头。

## 1.0.0

### Major Changes

- 首次发布 faapi——"函数即接口"的 Node.js API 框架。核心能力包括：基于 TypeScript AST 自动生成 zod schema 的类型校验、洋葱模型中间件、按参数名匹配的依赖注入、零入口设计（`faapi dev` / `faapi build` / `node dist/main`）、产物驱动架构（dev/prod 共享 `createAppBase`，无 `if (isDev)` 分支）、WebSocket 路由、SSE 流式响应、CORS/helmet/logger 内置中间件、tsconfig paths 别名、插件系统、业务方测试支持（`createContext`/`invokeHandler`）。多环境配置通过 `.env` 系列文件实现（参考 Next.js），启动时 `loadEnv` 加载到 `process.env`。

### Minor Changes

- `SseWriter` 新增 `sendRaw(chunk)` 方法，支持原始字节/字符串透传（不做 SSE 序列化）。适用于 LLM 中转平台场景——逐 chunk 透传上游已有的 SSE 原文，同时边透传边解析末尾 chunk 的 `usage` 字段落库。与 `send`（结构化事件序列化）互补，可混用。
- 将 `zod` 从 `dependencies` 改为 `peerDependencies`。框架生成的 `zod.js`（每个 handler 一个，运行时按需 import 做 `safeParse`）位于业务方项目目录，pnpm 严格 node_modules 布局下 `dependencies` 声明的 zod 被隔离在 `@faapi/faapi/node_modules/zod`，Node ESM 解析器从 `.faapi/**/zod.js` 向上查找 `node_modules/zod` 失败。改为 `peerDependencies` 后业务方项目根可解析到 zod。业务方需在项目 `package.json` 显式安装 `zod@^4`。

### Patch Changes

- 修复 dev watch 模式下偶发 `Cannot find package '@/lib'` 500 错误。根因：`compileDevRoutes` 用 esbuild 默认写文件（非原子），`rebuildRoutes` 期间 HTTP 请求可能读到写一半的产物（alias 未重写完）。修复：启用 esbuild `write: false`，拿到 `outputFiles` 后自行原子写（写临时文件 + `rename`，POSIX 原子）。仅 dev 需要（build 是一次性编译，运行时不并发）。
