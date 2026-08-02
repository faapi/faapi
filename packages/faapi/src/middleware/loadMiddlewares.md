# loadMiddlewares

一句话概括：加载 middlewares.ts 文件、校验中间件项、按路径列表合并多级中间件

## 为什么需要

路由目录可向上多级继承 middlewares.ts（根→路由目录，洋葱模型外→内）。
需要在请求阶段按 `middlewarePaths` 加载并合并中间件 + 注入器，且单文件加载带缓存避免重复 import。

## 使用场景

- **scanRoutes**（无 dist 模式，testServer/单测）：直接加载源码中间件并塞入 route.middlewares
- **createServer** / **handleWsUpgrade**（dev/prod 请求阶段）：`route.middlewares` 为 undefined 时调 `loadMergedMiddlewares(route.middlewarePaths)` 按需加载并缓存到 route 上
- **reloadRoutes**（watcher 热替换）：调 `invalidateMiddlewareCache()` 清缓存，下次请求重新加载

## 合并语义

`loadMergedMiddlewares(paths)` 按路径列表（根在前、路由目录在后）逐个加载：
- 子级中间件追加在父级之后（洋葱模型内层）
- 子级注入器覆盖父级同名注入器
- 单文件加载带缓存（`getCachedMiddlewares` / `setCachedMiddlewares`），重复调用仅首次真正加载

## 相关模块

- `middlewareTypes.ts` - 校验中间件项类型
- `injectorTypes.ts` - 注入器映射表类型
- `scanRoutes.ts` - 无 dist 模式下调用加载源码中间件
- `createServer.ts` / `handleWsUpgrade.ts` - 请求阶段按需加载
