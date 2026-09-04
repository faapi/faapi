# matchRoute

一句话概括：根据请求匹配路由，支持静态和动态路由；内部按清单数组身份（WeakMap）缓存路由索引，静态路由 O(1) 命中，动态路由按清单顺序扫描。

## 为什么需要

HTTP 请求到达后，需要找到对应的路由处理函数。支持静态路由（如 `/auth/login`）和动态路由（如 `/user/:id`），并提取动态参数。

路由匹配是每请求热路径。原实现逐条遍历清单（静态字符串比较 + 动态 `split('/')` 比对），大清单下开销显著。索引把清单分为静态 Map（`method|urlPath` → route）与动态数组两部分，静态命中从 O(n) 降为 O(1)。

## 匹配语义（与遍历式实现等价）

依赖 `sortRoutes` 的两条排序保证：

1. **静态路由恒排在动态路由之前**——静态 Map 优先查，等价于原遍历的首个命中
2. **同一 `(method, path)` 至多一条静态路由**——Map 不存在多命中歧义

动态路由保持清单顺序扫描（`sortRoutes` 内部的段数/字母序优先级不变）。

## 索引失效

索引按**清单数组身份**缓存（WeakMap）：`reloadRoutes` / `hydrateRoutes` 整体替换清单数组（`routesRef.current = newRoutes`），旧数组被替换后索引自动失效可被 GC——无生命周期侵入，无需手动清理。

## 导出

| 函数 | 说明 |
| --- | --- |
| `matchRoute(routes, method, path)` | HTTP 路由匹配，静态 O(1) + 动态线性扫描 |
| `matchWsRoute(wsRoutes, path)` | WS 路由匹配（无方法维度），索引策略同上 |
| `findAllowedMethods(routes, path)` | 路径的允许方法集合（405 响应用）：静态段索引直查，仅动态段扫描 |
| `matchDynamicPath(pattern, path, paramNames, isCatchAll?)` | 动态路径模式匹配（无索引，纯函数） |

## 使用场景

- HTTP 请求到达时匹配路由（`createServer` 每请求调用 `matchRoute`）
- WS 握手时按路径匹配（`handleWsUpgrade` 调 `matchWsRoute`）
- 未命中时反查允许方法，区分 404 / 405（`resolveRouteOrThrow` 调 `findAllowedMethods`）

## 相关模块

- `routeTypes.ts` - 输入输出类型
- `sortRoutes.ts` - 依赖排序后的路由清单（索引等价性的前提）
- `../server/createServer.ts` - 调用方（`matchRoute` + `findAllowedMethods`）
