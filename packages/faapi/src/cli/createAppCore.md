# createAppCore

一句话概括：dev/prod 共享的应用基础编排核心——完成「配置加载 → 路由清单水合 → 创建 server → 插件加载」，返回 `AppBase`（listen/close/inject）+ `AppContext`（供 dev 扩展 reloadRoutes）。

## 为什么需要

faapi 的核心架构决策是「dev/prod 走完全一致的读产物代码路径，差异仅由 `FAAPI_OUT_DIR` 环境变量驱动，无 `if (isDev)` 控制流分支」。`createAppBase` 是这个统一路径的实现：

- 不负责编译 TypeScript——编译由 `faapi dev`（esbuild → `.faapi/dev/`）和 `faapi build`（→ `dist/`）负责
- 不负责生成路由清单——`faapi dev`/`faapi build` 启动时生成 `faapi-routes.js`，`createAppBase` 直接水合
- 只负责读产物三元组（`faapi-config.js` + `faapi-routes.js` + `zod.js`）并组装成可运行的应用

dev 的 `createDevApp` 在 `createAppBase` 基础上增加 `reloadRoutes`（热替换）+ `setLoadTimestamp`（缓存失效）；prod 的 `createProdApp` 直接返回 `AppBase`。

## 使用场景

- `createDevApp`（dev 模式）调 `createAppBase` 获取 `app` + `ctx`，基于 `ctx.updateRoutes` 实现 `reloadRoutes`
- `createProdApp`（prod 模式）调 `createAppBase` 仅取 `app`，丢弃 `ctx`
- 编程式调用场景（自定义启动器、测试场景）

`outDir` 由 `process.env.FAAPI_OUT_DIR` 决定：`faapi dev` 设为 `.faapi/dev`，`node dist/main` 不设（默认 `dist`）。

## API

### CreateAppOptions

| 字段 | 说明 |
|------|------|
| `rootDir` | 项目根目录，默认 `process.cwd()` |
| `appDir` | 源码目录前缀，覆盖 `FAAPI_APP_DIR`，默认 `'src'` |
| `port` | 端口号，也可在 `listen()` 时传入；默认 `PORT` 环境变量或 `3000` |

### AppBase

| 方法 | 说明 |
|------|------|
| `listen(port?)` | 启动 HTTP server，打印路由表，执行 `onReady` 钩子，注册优雅关闭信号（仅当配置了 `onClose`） |
| `close()` | 幂等关闭 server，执行 `onClose` 钩子，`app.server` 置 null |
| `inject(options?)` | 无服务器测试注入——构造模拟请求直接走完整请求链路，不绑定端口；需在 `listen()` 前调用 |

端口优先级：`listen()` 参数 > `options.port` > `PORT` 环境变量 > 默认 `3000`。

### AppContext

供 dev 扩展 `reloadRoutes` 使用，prod 模式不使用：

| 字段 | 说明 |
|------|------|
| `rootDir` / `appDir` / `outDir` | 路径上下文 |
| `patterns` | scanRoutes 用的 glob 模式 |
| `server` | 未 listen 的 Server 实例 |
| `routesRef` | 路由可变引用容器（createServer 闭包和 reloadRoutes 共享） |
| `config` | 原始 FaapiConfig 或 null |
| `updateRoutes(routes, wsRoutes)` | 同步更新 app.routes/wsRoutes + routesRef + 闭包变量 |

## 关键行为

- 路由清单缺失（`<outDir>/faapi-routes.js` 不存在）→ 抛错（含 build/dev 提示）
- 路由冲突 → 仅 `console.warn`，不阻断启动
- `listen` 内仅当配置了 `lifecycle.onClose` 时注册 SIGTERM/SIGINT 优雅关闭
- `close` 幂等（`closed` 标志）；HTTP/2 连接清理方法 feature-detect
- `inject` 无 handler 时 reject；`JSON.parse` 失败回退为字符串

## 相关模块

- `createDevApp.ts` - dev 模式启动，基于 `createAppBase` 增加 `reloadRoutes`
- `createProdApp.ts` - prod 模式启动，直接委托 `createAppBase`
- `createApp.ts` - `createProdApp` 的向后兼容别名
- `loadConfig.ts` - 读 `<outDir>/faapi-config.js`
- `createServer.ts` - 创建 HTTP server + 路由匹配 + 请求处理
- `loadPlugins.ts` - 加载插件并返回 handler/upgrade 包装器
- `startServer.ts` - `applyPluginWrappers` 应用包装器到 server
- `generateRoutes.ts` - `hydrateRoutes` 水合序列化路由清单
- `importWithCacheBust.ts` - 加载路由清单（watch 模式带时间戳绕缓存）
