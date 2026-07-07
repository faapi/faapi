# 命令行工具

提供 dev / build 两个命令，是 faapi 框架的入口。dev 与 build 为两套独立代码路径，仅共享工具级函数。dev 模式调用 `createDevApp()`（含 reloadRoutes 热替换），prod 模式由 `faapi build` 生成 `dist/main.js` 启动入口，`node dist/main` 调用 `createProdApp()`（精简）。

## 零入口设计

框架采用零入口设计——用户无需编写 `main.ts`：

- dev：`faapi dev` 内部调 `createDevApp()` + `listen()`
- prod：`faapi build` 自动生成 `dist/main.js` 启动入口（内部 import `createProdApp` + `listen`），`node dist/main` 直接启动

用户自定义启动逻辑（初始化数据库、注册信号处理等）通过 `faapi.config.ts` 的 `lifecycle.onReady` / `onClose` 钩子实现，dev/prod 都执行。

`createApp` / `createProdApp` / `createDevApp` 主要供编程式调用场景使用（如自定义启动器、测试场景），`dist/main.js` 内部也调用它们完成启动。

## 命令体系

| 命令 | 模式 | 行为 |
|------|------|------|
| `faapi` / `faapi dev` | dev | 编译 `.ts` → `.faapi/*.js` + 生成产物三元组 + 调用 `createDevApp()` 启动 dev 应用 + watch 热替换 |
| `faapi build` | 构建 | 逐文件编译（bundle: false） `.ts` → `dist/*.js` + 生成产物三元组（`dist/faapi-config.js` + `dist/faapi-routes.js` + 各 handler 的 `zod.js`）+ 生成 `dist/main.js` 启动入口，不启动服务器 |
| `node dist/main` | 生产 | 直接运行 `dist/main.js`，内部调 `createProdApp()` + `listen()`，读 `dist/` 产物三元组启动服务 |

dev 和 prod 走完全一致的读产物代码路径（`createAppBase`），差异仅由 `FAAPI_DIST` 环境变量（路径参数）驱动，无 `if (isDev)` 控制流分支。`NODE_ENV`/`FAAPI_ENV` 仅用于 `compileConfig` 选择环境配置文件。

## 模块

| 模块 | 说明 |
| --- | --- |
| [index.ts](./index.ts) | CLI 入口，分发 dev/build 命令 |
| [devCommand.ts](./devCommand.ts) | dev 模式编排：设 `FAAPI_DIST` → 编译 + 生成产物三元组 → 调用 `createDevApp()` + `listen()` → 启动 watcher |
| [createAppCore.ts](./createAppCore.ts) | dev/prod 共享的编排核心（`createAppBase`）：配置/路由水合/schema/插件/listen/close |
| [createDevApp.ts](./createDevApp.ts) | dev 入口：`createAppBase` + `reloadRoutes` 热替换（由 devCommand 内部调用） |
| [createProdApp.ts](./createProdApp.ts) | prod 入口：`createAppBase`（精简，无 reloadRoutes，由 `dist/main.js` 内部调用） |
| [createApp.ts](./createApp.ts) | `createProdApp` 的向后兼容别名 |
| [buildCommand.ts](./buildCommand.ts) | 构建：编译 TypeScript → 编译配置 → 扫描路由 → schema 文件 → 路由清单 → 生成 `dist/main.js` 启动入口 |
| [compileDevRoutes.ts](./compileDevRoutes.ts) | dev 专用编译：esbuild 逐文件编译 `.ts` 到 `.faapi/`（启动快、增量编译友好） |
| [compileBuildRoutes.ts](./compileBuildRoutes.ts) | build 专用编译：esbuild bundle 模式 + splitting + tree shaking + 死分支删除 |
| [aliasPlugin.ts](./aliasPlugin.ts) | esbuild 别名重写插件（dev/build 编译器共用） |
| [compileConfig.ts](./compileConfig.ts) | 配置编译合并：`faapi.config.ts` + `faapi.config.{env}.ts` → 单个 `faapi-config.js`（dev/build 共用） |
| [generateSchemaFiles.ts](./generateSchemaFiles.ts) | schema 生成：为每个 handler 生成 `zod.js`（zod schema + 字段元数据，与 handler.js 同级） |
| [collectRouteSchemaSources.ts](./collectRouteSchemaSources.ts) | AST 提取入口：从路由清单收集 schema 源数据（dev/prd 共用） |
| [generateRoutes.ts](./generateRoutes.ts) | 路由清单：序列化为 `faapi-routes.js` + 水合还原（hydrateRoutes） |
| [watcher.ts](./watcher.ts) | dev watch：监听 src + 根配置文件，增量编译 + 重生成 config + 调 `app.reloadRoutes()` 热替换 |
| [normalizePatterns.ts](./normalizePatterns.ts) | pattern 标准化：逗号分隔→数组 |

## CLI 选项

CLI 无选项，应用行为配置通过 `faapi.config.ts` 控制，框架元信息（`port`/`dist`）通过环境变量控制。

CORS 等运行时配置请使用 `faapi.config.ts`。

## 启动流程

### dev 模式（`faapi` / `faapi dev`）

```
devCommand
  → 设 FAAPI_DIST=.faapi（+ 兜底 NODE_ENV=development）
  → compileConfig(faapi.config.ts + env → .faapi/faapi-config.js)
  → loadConfig 读应用行为配置
  → compileDevRoutes(src/**/*.ts → .faapi/**/*.js)
  → generateRouteArtifacts(faapi-routes.js + zod.js)
  → createDevApp({ rootDir }) + app.listen()（含 reloadRoutes 热替换能力）
  → startWatcher({ rootDir, app })（增量编译 + 重生成 config + app.reloadRoutes 热替换）
```

dev 模式不运行用户入口文件——devCommand 直接调用 `createDevApp()` 持有 app 引用后传给 watcher。

### 生产模式（`node dist/main`）

```
node dist/main.js（运行 build 阶段生成的启动入口）
  → import { createProdApp } from '@faapi/faapi'
  → createProdApp() 读 FAAPI_DIST（未设置时默认 'dist'）
  → 校验 dist/faapi-routes.js 存在
  → loadConfig(dist/faapi-config.js)
  → hydrateRoutes(dist/faapi-routes.js → 加载中间件)
  → createServer → listen（schema 由 build 时生成 zod.js，运行时按需 import）
```

`dist/main.js` 是 `faapi build` 自动生成的启动入口（零入口设计：用户无需编写 main.ts），内部仅 `import { createProdApp } from '@faapi/faapi'` + `createProdApp()` + `listen()`。`createProdApp()` 统一读 `dist/` 产物三元组，与 dev 模式的 `createDevApp()` 走完全相同的 `createAppBase` 代码路径，差异仅在 `FAAPI_DIST` 值不同。

## build 流程

```
buildCommand
  → collectBundleEntries(handler.ts + middlewares.ts)
  → compileBuildRoutes(bundle 模式 → dist/**/*.js，tree shaking + splitting)
  → compileConfig(faapi.config.ts + env → dist/faapi-config.js)
  → loadConfig 读应用行为配置
  → scanRoutes(import 产物 .js) + sortRoutes + generateSchemaFiles(dist/**/zod.js)
  → serializeRoutes + writeRoutesModule(dist/faapi-routes.js)
  → 生成 dist/main.js 启动入口（import createProdApp + listen）
```

产物：
- `dist/**/handler.js` — 编译后的路由文件（打平 `src/` 前缀，如 `dist/api/hello/handler.js`）
- `dist/**/zod.js` — zod schema 模块（与 handler.js 同级，运行时类型校验的数据来源）
- `dist/faapi-config.js` — 配置合并产物（faapi.config.ts + env 合并，自包含 deepMerge）
- `dist/faapi-routes.js` — 序列化路由清单（生产模式路由来源，含 middlewarePaths）
- `dist/main.js` — 启动入口（零入口设计：build 阶段自动生成，内部 import `createProdApp` + `listen`）

## 相关模块

- [router](../router/README.md)：路由扫描与排序
- [server](../server/README.md)：HTTP 服务启动
- [@faapi/schema](../../../schema/)：路由 schema 扩展包，通过 MCP 暴露路由信息给 LLM
- [validator](../validator/README.md)：输入校验（消费 zod.js）
