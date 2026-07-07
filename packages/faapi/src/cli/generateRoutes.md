# generateRoutes

一句话概括：build 时序列化路由清单为 JS 模块，生产 `createApp` 时水合还原（加载中间件）。

## 为什么需要

生产模式不应重新扫描文件系统（生产环境无需 glob）。
build 时把路由元数据序列化为 `dist/faapi-routes.js`，生产 `createApp` 时 import 读取并水合：
按 `middlewarePaths` 重新加载中间件文件，还原洋葱模型与注入器（函数无法序列化）。

## 使用场景

- `faapi build`：`serializeRoutes` + `writeRoutesModule` 生成 `dist/faapi-routes.js`
- `node dist/main`（prd）：`createProdApp` 内部 `import` 读取清单 + `hydrateRoutes` 加载中间件还原 `RouteManifest`

## 序列化策略

- `filePath`：源码形式（`src/api/user/handler.ts`）→ 产物形式（`dist/api/user/handler.js`，打平 `src/` 前缀）
- `middlewares`/`injectors`：函数无法序列化，改为 `middlewarePaths`（中间件文件绝对路径列表，根在前）
- `middlewarePaths`：build 时向上查找 `middlewares.{ts,js}`（优先 .ts），转为产物形式绝对路径（同样打平 src 前缀）

## 水合策略

- 按 `middlewarePaths` 顺序加载中间件文件（复用 `loadMiddlewaresFile` + 缓存）
- 合并逻辑与 `scanRoutes.findMergedMiddlewares` 一致：父级在前子级追加，子级注入器覆盖父级同名

## 相关模块

- `buildCommand.ts` - build 时调用序列化与写入
- `createAppCore.ts` - 生产启动时调 `createAppBase` 读取与水合
- `scanRoutes.ts` - dev 模式扫描路由（水合逻辑与之对齐）
- `loadMiddlewares.ts` - 中间件加载与缓存
