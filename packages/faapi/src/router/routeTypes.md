# routeTypes

一句话概括：定义路由相关的核心类型，包括 HTTP 路由、WS 路由、路由匹配结果、可变引用容器、schema 描述类型。

## 为什么需要

路由层多个模块（扫描、匹配、排序、冲突检测、序列化、水合）共享同一套类型定义。集中定义避免循环依赖和类型不一致。

## 使用场景

- `scanRoutes` 返回 `RouteManifest`
- `matchRoute` 接收 `RouteManifest`，返回 `RouteMatch`
- `sortRoutes` 接收并返回 `RouteManifest`
- `detectRouteConflicts` 接收 `RouteManifest`
- `serializeRoutes` / `hydrateRoutes` 在 `RouteRecord` 与 `SerializedRouteRecord` 之间转换

## RouteRecord 中间件相关字段（按需加载设计）

`RouteRecord` 和 `WsRouteRecord` 包含三个中间件相关字段，共同支撑**中间件按需加载**（dev/prod 通用，Vite 风格）：

| 字段 | 类型 | 用途 |
|------|------|------|
| `middlewarePaths` | `string[]?` | 中间件文件绝对路径列表（根在前，路由目录在后）。启动时由 `scanRoutes` / `hydrateRoutes` 收集并存储，**不触发模块加载** |
| `middlewares` | `FaapiMiddleware[]?` | 路由对应的中间件集合（从根到路由目录合并）。首次请求时由 `createServer` / `handleWsUpgrade` 调 `loadMergedMiddlewares` 加载并缓存 |
| `injectors` | `InjectorMap?` | 路由对应的注入器映射表（从根到路由目录合并）。与 `middlewares` 同步加载并缓存 |

**路径收集 vs 加载缓存分离**：启动时只收集 `middlewarePaths`（零 import 中间件模块，dev 近乎瞬开），首次请求时才 `loadMergedMiddlewares(middlewarePaths)` 加载并写入 `middlewares` / `injectors`，后续请求直接复用缓存。watcher 文件变化时 `invalidateMiddlewareCache` 清缓存，下次请求重新加载。

## 相关模块

- [constants](./constants.md) - 提供 `HttpMethod` 类型
- [scanRoutes](./scanRoutes.md) - 生成 `RouteManifest`，收集 `middlewarePaths`
- [matchRoute](./matchRoute.md) - 使用 `RouteMatch` / `WsRouteMatch`
- [generateRoutes](../cli/generateRoutes.md) - 序列化/水合 `RouteRecord`，传递 `middlewarePaths`
- [loadMiddlewares](../middleware/loadMiddlewares.md) - `loadMergedMiddlewares` 按需加载中间件
- [createServer](../server/createServer.md) - 请求阶段按需加载中间件到 `route.middlewares`
- [handleWsUpgrade](../server/handleWsUpgrade.md) - WS 握手阶段按需加载中间件
