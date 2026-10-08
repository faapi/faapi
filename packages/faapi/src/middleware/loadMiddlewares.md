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

## 错误口径（不降级）

加载/校验失败一律显式抛错，**不再降级为空 bundle**（空 bundle 让服务带病运行——鉴权/CORS 中间件静默失效后请求绕过横切能力直接命中 handler，比显式 500 更危险）：

- 文件 import 失败（语法错误 / 路径不存在 / 运行时抛错）→ 原始错误冒泡
- `default`/`middlewares` 导出非数组、中间件项非函数、`injectors` 导出非对象、注入器值非函数 → `TypeError`（含文件路径与字段说明）

失败后果：命中该路由的请求 500（`onError` 钩子可感知），dev 下 watcher 修复文件后 `reloadRoutes` 触发 `invalidateMiddlewareCache` 自愈。加载失败不写缓存（内存与 in-flight 均不缓存失败结果），下次请求重试加载。

## 相关模块

- `middlewareTypes.ts` - 校验中间件项类型
- `injectorTypes.ts` - 注入器映射表类型
- `scanRoutes.ts` - 无 dist 模式下调用加载源码中间件
- `createServer.ts` / `handleWsUpgrade.ts` - 请求阶段按需加载
- `src/cli/compileOnDemand.ts` - dev 按需编译中间件产物（编译失败同样冒泡）
