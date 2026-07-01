# watcher

一句话概括：监听源码 `.ts` 变化，增量编译 + 重新扫描路由和 schema，实现 dev 模式热更新。

## 为什么需要

开发模式下，用户修改 `handler.ts` 或 `middlewares.ts` 后需要立即看到效果，无需手动重启服务。`watcher` 封装了文件监听、增量编译、缓存清理、路由重建的完整流程，使 dev server 具备热更新能力。

## 使用场景

- `faapi` / `faapi dev` 启动时调用 `startWatcher`，进入 watch 模式
- 开发者编辑 handler.ts / middlewares.ts / util.ts 后自动触发重建
- 新增/删除/修改路由文件均触发重建

## API

| 方法 | 说明 |
|------|------|
| `startWatcher(options)` | 启动 watch 模式，监听文件变化并自动重建路由和 schema |

### WatchOptions

| 字段 | 说明 |
|------|------|
| `rootDir` | 项目根目录 |
| `patterns` | 路由文件 glob 模式（用于 scanRoutes，不再用于 chokidar 监听） |
| `appDir` | app 目录路径（chokidar 监听此目录） |
| `server` | HTTP Server 实例 |
| `port` | 监听端口 |
| `cors` | 是否启用 CORS |
| `staticDir` | 静态文件目录 |
| `types` | RPC 类型文件路径 |

## 监听方式

chokidar v4 移除了 glob 模式支持（README 明确说明 "removes support for globs"），因此改为监听整个 `appDir` 目录 + `ignored` 函数过滤。

监听整个 appDir 比 glob 更合理：handler.ts 引用的 util.ts 变化也能触发重建（增量编译 + 全量扫描，scanRoutes 会重新 import 所有产物）。

`ignored` 函数逻辑：
- 忽略 `node_modules`、`.faapi`、`dist`、`.git` 路径
- 无 stats 时不忽略（chokidar 会再次调用并传入 stats）
- 目录不忽略（chokidar 需要递归进入子目录）
- 文件仅监听 `.ts` 后缀

## 重建流程

文件变化 → debounce(100ms) → 重建：

1. 更新全局时间戳 `__FAAPI_LOAD_TS__`，ESM import 时拼接该时间戳绕过缓存
2. 清理中间件缓存（`invalidateMiddlewareCache`）
3. 清理 TS Program 缓存（`invalidateProgramCache`）
4. 增量编译变化的文件（`compileRoutes` with `files` 参数，只编译 add/change 的文件）
5. 全量扫描路由（`scanRoutes`，import 产物 `.js`，filePath 保持源码 `.ts`）
6. 重新生成 schema 文件（`.faapi/dev/faapi-schema.js`）并加载到 `schemaRegistry`
7. 通过全局状态 `__FAAPI_ROUTES__` / `__FAAPI_WS_ROUTES__` 让 server 使用最新路由

### 增量编译 + 全量扫描的理由

- 增量编译：只编译变化的文件，速度快
- 全量扫描：路由结构可能变化（新增/删除 handler.ts），需要全量扫描保证一致性；scanRoutes 内部用 importWithCacheBust，已更新时间戳后会重新 import 产物

unlink（文件删除）不增量编译（无文件可编译），但触发全量扫描，scanRoutes 通过 patterns glob 自然排除已删除的文件。

## 相关模块

- [cli/compileRoutes.ts](./compileRoutes.md) - 增量编译
- [cli/generateSchema.ts](./generateSchema.md) - 生成 schema 文件并加载
- [router/scanRoutes.ts](../router/scanRoutes.ts) - 路由扫描
- [router/sortRoutes.ts](../router/sortRoutes.ts) - 路由排序
- [middleware/loadMiddlewares.ts](../middleware/loadMiddlewares.ts) - 中间件缓存清理
- [ast/createProgram.ts](../ast/createProgram.ts) - Program 缓存清理
- [validator/schemaRegistry.ts](../validator/schemaRegistry.ts) - schema 注册表
