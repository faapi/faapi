---
'@faapi/faapi': major
'@faapi/schema': major
'@faapi/next': major
---

首次发布 faapi——"函数即接口"的 Node.js API 框架。

## @faapi/faapi（核心包）

### 核心理念

编写普通 TypeScript 函数即可暴露为 HTTP / WebSocket 接口，类型校验由 TypeScript AST 自动生成 zod schema，无需手写。

### 路由约定

```
src/api/**/handler.ts
```

导出 HTTP 方法名函数（`GET`/`POST`/`PUT`/`PATCH`/`DELETE` 等）即声明路由，导出 `WS` 函数声明 WebSocket 路由。

命名规则：`[id]` 动态参数、`[...slug]` catch-all、`(group)` 分组（不影响 URL）。

### 零入口设计

无需编写 `main.ts`。`faapi` / `faapi dev` 启动开发服务器并监听变更热替换，`faapi build` 构建 `dist/` 产物并自动生成 `dist/main.js` 生产入口，`node dist/main` 直接启动。

用户自定义启动逻辑（数据库初始化、资源清理等）通过 `faapi.config.ts` 的 `lifecycle.onReady` / `onClose` 钩子实现。

### 类型校验

- **AST 提取**：TypeScript Compiler API 分析 handler 参数类型，生成 `RuntimeType` 结构化描述
- **Per-handler zod schema**：每个 handler 生成独立 `zod.js`（如 `dist/api/hello/zod.js`），运行时 `validateInput` 按需 import + zod `safeParse`
- **Coerce**：query/params（URL 字符串）自动 `z.preprocess` 包裹类型转换，body（JSON）不转换
- **循环引用**：`z.lazy(() => ...)` 延迟求值
- **跨文件引用**：AST 提取阶段已解析为完整 `RuntimeType`（内联），每个 `zod.js` 自包含
- **严格模式**：不支持的类型抛 `SchemaExtractionError`，不降级为 `any`
- 公用 helper（`coerceNumber`/`coerceBoolean`）提取到 `faapi-helpers.js` 复用

### 中间件（洋葱模型）

单一 async 函数 `(ctx, next) => {}`，`await next()` 前后衔接前置/后置逻辑。两层叠加：全局中间件（`faapi.config.ts`）→ 目录中间件（`middlewares.ts`）→ handler。

执行顺序：CORS → 全局中间件 → 目录中间件（从根到路由）→ handler。

### 依赖注入

按参数名匹配注入到 handler 参数，与中间件解耦。

内置注入类型：`query`/`body`/`params`/`headers`/`context`/`ctx`/`cookies`/`ip`/`files`/`fields`。用户自定义注入器在 `middlewares.ts` 中命名导出 `injectors`。

### 配置文件 `faapi.config.ts`

应用行为配置：`cors`/`lifecycle`/`middlewares`/`injectors`/`extendContext`/`plugins`/`helmet`/`bodyLimit`/`logger`/`http2` + 自定义业务配置（通过 `ctx.config` 访问）。统一响应格式与错误处理通过辅助函数 + 全局中间件实现（框架不内置统一响应包装/错误格式化配置）。

多环境配置：`faapi.config.{env}.ts` 深度合并（`FAAPI_ENV` 或 `NODE_ENV` 选择环境）。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FAAPI_APP_DIR` | `'src'` | 源码目录（`.` = 根目录） |
| `PORT` | `3000` | 服务端口 |
| `FAAPI_OUT_DIR` | dev 固定 `.faapi/dev`，prod 默认 `dist` | 产物目录 |
| `FAAPI_ENV` | — | 环境选择（高于 `NODE_ENV`） |
| `NODE_ENV` | dev 兜底 `development` | 环境选择 + 运行时读取 |

### CLI

```
faapi / faapi dev    开发模式（编译 → 产物生成 → 启动 → watcher 热替换）
faapi build          生产构建（编译 → bundle + tree shaking → 自动生成 dist/main.js）
node dist/main       生产运行
```

### 基础能力

- **动态路由**：`[id]`/`[...slug]`/`(group)`
- **WebSocket**：`WS` 函数声明路由，握手阶段复用洋葱中间件，`WsContext`/`WsSocket`/`WsEventHandlers`
- **SSE 流式响应**：`ctx.sse()` 返回 `SseWriter`（零外部依赖，基于 `ReadableStream`）
- **CORS**：`config.cors` 配置
- **文件上传**：`multipart/form-data` 解析
- **IP 注入**：`ip` 参数（`x-forwarded-for` 优先）
- **tsconfig paths 别名**：编译时 esbuild 插件自动重写，三种模式均无需额外配置
- **插件系统**：`FaapiPlugin { name, setup(ctx) }`，支持 `wrapHandler`/`wrapUpgradeHandler`

### 产物驱动架构

dev 和 prod 生成完全一致的产物三元组，`createAppBase` 内部无 `if (isDev)` 分支，差异仅由 `FAAPI_OUT_DIR` 驱动：

| 产物 | dev | prod |
|------|-----|------|
| 路由/middleware `.js` | `.faapi/dev/**/*.js` | `dist/**/*.js` |
| `faapi-config.js` | `.faapi/dev/faapi-config.js` | `dist/faapi-config.js` |
| `faapi-routes.js` | `.faapi/dev/faapi-routes.js` | `dist/faapi-routes.js` |
| `zod.js` | `.faapi/dev/**/zod.js` | `dist/**/zod.js` |

Dev 编译：`bundle: false` 逐文件编译，启动快、增量友好。
Build 编译：`bundle: true` + `splitting: true` + `minifySyntax: true` + `define: { 'process.env.NODE_ENV': '"production"' }`，tree shaking + 死分支删除。

### 编程式 API

```ts
import { createDevApp, createProdApp, createApp } from '@faapi/faapi';
// createDevApp: dev 模式（含 reloadRoutes 热替换）
// createProdApp: prod 模式（精简）
// createApp: createProdApp 的向后兼容别名
```

## @faapi/schema（schema 扩展包）

通过 MCP 协议（stdio transport）暴露路由 schema 给 AI 助手，提供三个 tool：

- `list_routes`：列出所有路由
- `get_route_schema`：获取单个路由的详细 schema
- `get_api_schema`：获取完整 API schema（类似 OpenAPI）

在 `faapi.config.ts` 的 `plugins` 字段声明即可加载，不声明即不启用。

## @faapi/next（Next.js 集成包）

Next.js + faapi 单进程单端口集成。通过 `wrapHandler`/`wrapUpgradeHandler` 包装请求处理：
- `/api/*` 走 faapi
- 其余路径走 Next.js（含 HMR）

在 `faapi.config.ts` 的 `plugins` 字段声明即可加载。配置选项：`dev`/`dir`/`apiPrefix`。

## 许可证

[MIT](./LICENSE)
