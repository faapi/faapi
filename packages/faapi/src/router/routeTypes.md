# routeTypes

一句话概括：定义路由相关的核心类型。

## 为什么需要

路由层多个模块（扫描、匹配、排序、冲突检测）共享同一套类型定义。集中定义避免循环依赖和类型不一致。

## 使用场景

- `scanRoutes` 返回 `RouteManifest`
- `matchRoute` 接收 `RouteManifest`，返回 `RouteMatch`
- `sortRoutes` 接收并返回 `RouteManifest`
- `detectRouteConflicts` 接收 `RouteManifest`

## 相关模块

- `constants.ts` - 提供 `HttpMethod` 类型
- `scanRoutes.ts` - 生成 `RouteManifest`
- `matchRoute.ts` - 使用 `RouteMatch`
