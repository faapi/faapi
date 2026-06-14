# watcher

一句话概括：监听文件变化，全量重建路由清单和 schema，实现 dev 模式热更新。

## 为什么需要

开发模式下，用户修改 `handler.ts` 或 `middlewares.ts` 后需要立即看到效果，无需手动重启服务。`watcher` 封装了文件监听、缓存清理、路由重建的完整流程，使 dev server 具备热更新能力。

选择全量重建而非增量更新的理由：

- 简单可靠，无状态一致性问题
- 跨文件类型引用自然解决（全量提取时所有类型都在）
- dev 模式文件量有限，全量提取在百毫秒级，debounce 后用户无感

## 使用场景

- `faapi` / `faapi dev` 启动时调用 `startWatcher`，进入 watch 模式
- 开发者编辑 handler.ts / middlewares.ts 后自动触发重建
- 新增/删除/修改路由文件均触发全量重建

## API

| 方法 | 说明 |
|------|------|
| `startWatcher(options)` | 启动 watch 模式，监听文件变化并自动重建路由和 schema |

### WatchOptions

| 字段 | 说明 |
|------|------|
| `rootDir` | 项目根目录 |
| `patterns` | 路由文件 glob 模式 |
| `appDir` | app 目录路径 |
| `server` | HTTP Server 实例 |
| `port` | 监听端口 |
| `cors` | 是否启用 CORS |
| `staticDir` | 静态文件目录 |
| `types` | RPC 类型文件路径 |

## 重建流程

文件变化 → debounce(100ms) → 全量重建：

1. 更新全局时间戳 `__FAAPI_LOAD_TS__`，ESM import 时拼接该时间戳绕过缓存
2. 清理中间件缓存（`invalidateMiddlewareCache`）
3. 清理 TS Program 缓存（`invalidateProgramCache`）
4. 重新扫描路由（HTTP + WS）
5. 全量提取 schema 并加载到 `schemaRegistry`
6. 通过全局状态 `__FAAPI_ROUTES__` / `__FAAPI_WS_ROUTES__` 让 server 使用最新路由

监听范围：路由 patterns + `middlewares.ts` 文件。忽略 `node_modules`、`.faapi`、`dist` 目录。

## 相关模块

- [cli/generateSchema.ts](./generateSchema.md) - 全量提取 schema
- [router/scanRoutes.ts](../router/scanRoutes.ts) - 路由扫描
- [router/sortRoutes.ts](../router/sortRoutes.ts) - 路由排序
- [middleware/loadMiddlewares.ts](../middleware/loadMiddlewares.ts) - 中间件缓存清理
- [ast/createProgram.ts](../ast/createProgram.ts) - Program 缓存清理
- [validator/schemaRegistry.ts](../validator/schemaRegistry.ts) - schema 注册表
