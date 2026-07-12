# watcher

一句话概括：监听源码 `.ts`/`.js` 变化，增量编译 + 重生成 config 产物 + 调 `app.reloadRoutes()` 实现 dev 模式热更新。

## 为什么需要

开发模式下，用户修改 `handler.ts` 或 `middlewares.ts` 后需要立即看到效果，无需手动重启服务。`watcher` 封装文件监听和增量编译，配合 `createDevApp.reloadRoutes()` 完成热替换。

## 使用场景

- `faapi` / `faapi dev` 启动时由 `devCommand` 调用 `startWatcher`，进入 watch 模式
- 开发者编辑 handler.ts / middlewares.ts / util.ts / faapi.config.ts 后自动触发重建
- 新增/删除/修改路由文件均触发重建

## API

| 方法 | 说明 |
|------|------|
| `startWatcher(options)` | 启动 watch 模式，增量编译 + 重生成 config + 调 `app.reloadRoutes()` |

### WatchOptions

| 字段 | 说明 |
|------|------|
| `rootDir` | 项目根目录 |
| `app` | dev 应用实例（`DevApp`，调用 `app.reloadRoutes()` 热替换） |

## 监听范围

chokidar v4 移除了 glob 模式支持，改为监听整个 `src` 目录 + `ignored` 函数过滤。

监听范围：

- `src` 目录（递归监听整个源码目录，含 handler.ts 引用的 util.ts）
- 根目录的 `faapi.config.{ts,js}`（配置变化时重生成 `faapi-config.js`）

监听整个 src 比 glob 更合理：handler.ts 引用的 util.ts 变化也能触发重建。

`ignored` 函数逻辑：

- 忽略 `node_modules`、`.faapi`、`dist`、`.git` 路径
- 无 stats 时不忽略（chokidar 会再次调用并传入 stats）
- 目录不忽略（chokidar 需要递归进入子目录）
- 文件仅监听 `.ts` 和 `.js` 后缀（`.js` 用于 `faapi.config.js`）

## 重建流程

文件变化 → debounce(100ms) → 重建：

1. **增量编译**变化的文件（`compileDevRoutes` with `files` 参数，只编译 add/change 的文件）
2. **重生成 `faapi-config.js`**（`compileConfig`，内部按源文件存在性决定是否生成，无配置则跳过）
3. **调 `app.reloadRoutes()`**（由 `createDevApp` 提供，完成以下工作）：
   - 更新模块加载时间戳（`setLoadTimestamp(Date.now())`，ESM import 绕过缓存）
   - 清理中间件 + Program + schema 缓存
   - 全量扫描路由（`scanRoutes`，import 产物 `.js`）
   - 重新生成 schema 文件（`generateSchemaFiles` 生成 zod.js）+ `invalidateSchemaCache` 清空模块缓存
   - `ctx.updateRoutes` 更新 `app.routes` / `app.wsRoutes` 和 `routesRef.current` / `routesRef.wsCurrent`（server 使用最新路由）

### 与 `createDevApp.reloadRoutes()` 的分工

| 职责 | 由谁完成 |
|------|---------|
| 增量编译变化的文件 | `watcher`（`compileDevRoutes` with `files`） |
| 重生成 `faapi-config.js` | `watcher`（`compileConfig`） |
| 清缓存 + 重新扫描 + schema + 更新引用 | `createDevApp.reloadRoutes()` |

watcher 是 CLI 侧的薄封装，核心重建逻辑在 `createDevApp.reloadRoutes()` 中。

### app 引用传递

`devCommand` 调用 `createDevApp()` 后直接持有 app 引用，通过 `WatchOptions.app` 传给 `startWatcher`，无需全局变量。

### 不重生成 `faapi-routes.js`

watcher 不在重建流程中重生成 `faapi-routes.js`——`reloadRoutes` 直接调 `scanRoutes` 重新扫描，不依赖重新 import `faapi-routes.js`。原因：ESM 模块缓存难以通过 `?t=timestamp` URL 参数可靠绕过，直接 `scanRoutes` 更稳定。

`faapi-routes.js` 只在启动时由 `generateRouteArtifacts` 生成一次，watcher 触发的热替换走 `scanRoutes` 直通路径。

unlink（文件删除）不增量编译（无文件可编译），但触发 `reloadRoutes()`（路由结构变化）。

## 相关模块

- `createDevApp.ts` - 提供 `app.reloadRoutes()`，watcher 调用它完成热替换
- `createAppCore.ts` - `createDevApp` 的共享编排核心（createAppBase）
- `compileDevRoutes.ts` - 增量编译
- `compileConfig.ts` - 重生成 `faapi-config.js`
- `devCommand.ts` - 启动 watcher 的入口，传递 app 引用
