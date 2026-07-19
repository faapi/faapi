# @faapi/faapi

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
