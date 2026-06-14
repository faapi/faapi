---
"@faapi/faapi": major
"@faapi/schema": major
"@faapi/next": major
---

首次发布 faapi——"函数即接口"的 Node.js API 框架

**@faapi/faapi（核心包）**

- CLI：`faapi` 启动 dev server（默认扫描 `api/**/*.ts`），`faapi build` 构建，`faapi --types` 生成 RPC 类型
- 路由约定：`api/<路径>/handler.ts` 导出 HTTP 方法名（`GET`/`POST`/`PUT`/`DELETE`/`PATCH` 等）
- 路由能力：动态路由 `[id]`、catch-all `[...slug]`、分组 `(name)` 不影响 URL
- 类型校验：基于 TypeScript AST 提取类型，生成运行时校验函数
  - 支持基础类型、对象、数组、可选字段、字面量联合、enum、tuple、Date、Pick/Omit
  - 循环引用 + 跨文件类型引用
  - 不支持的类型抛 `SchemaExtractionError`，不降级为 `any`
- 中间件：洋葱模型（单一 async 函数 + `await next`），父子目录叠加，全局中间件
- 注入器：按参数名注入（`query`/`body`/`params`/`headers`/`ctx`/`cookies`/`files`/`fields`），与中间件解耦
- 配置文件 `faapi.config.ts`：
  - `responseFormat` 统一响应包装
  - `errorFormat` 错误格式自定义（fallback 链：errorFormat → formatErrorResponse → 最简 500）
  - `lifecycle` 钩子（`onReady` / `onClose` / `onError`）
  - `extendContext` 扩展 ctx
  - `middlewares` / `injectors` 全局中间件与注入器
  - `plugins` 插件声明
  - 自定义业务配置通过 `ctx.config` 访问
  - 多环境配置（`NODE_ENV` / `FAAPI_ENV`，深度合并）
- ctx 便捷方法：`json` / `html` / `redirect` / `sse`
- SSE 流式响应（`ctx.sse()` / `SseWriter`，`text/event-stream`，aborted 检测）
- WebSocket 路由级支持（导出 `WS` 函数，事件对象 API，`WsSocket` 封装，握手阶段复用洋葱中间件）
- 文件上传 `multipart/form-data` 解析
- CORS / 静态文件服务 / watch 模式
- 插件系统：`FaapiPlugin { name, setup(ctx) }`，支持 `wrapHandler` / `wrapUpgradeHandler`
- 公开 AST 能力：`createProgram` / `extractTypeInfo` / `getSchemaProperties` 等

**@faapi/schema（扩展包）**

- 通过 MCP 协议暴露路由 schema 给 AI 助手
- 组合主包公开 AST 能力生成路由 schema，不依赖主包内部模块
- 环境变量 `FAAPI_SCHEMA` 启用

**@faapi/next（集成包）**

- Next.js + faapi 单进程单端口集成
- 通过 `faapi.config.ts` 的 `plugins` 字段加载
- HTTP 分流：`/api/*` 走 faapi，其余走 Next.js
- WS 分流：faapi WS 路由走原始 upgrade handler，其余走 Next.js HMR
- 插件选项：`dev` / `dir` / `apiPrefix`
- `next` 作为 optional peerDependency
