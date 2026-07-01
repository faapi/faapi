# startCommand

一句话概括：CLI 启动命令的完整流程，按 mode 走 dev 或 prd 分支。

## 为什么需要

串联参数解析、路由获取、schema 加载、服务启动的完整流程，是 CLI 的核心入口。
dev 与 prd 共用 createServer / handleRequest / validateInput，差异仅在路由与 schema 来源。

## 使用场景

- `faapi` / `faapi dev`：dev 模式，扫描 `.ts`，watch，全量提取 schema
- `faapi start`：prd 模式，加载 `dist/faapi-routes.js` 路由清单 + `dist/faapi-schema.js` schema，不 watch

## 流程

### dev 模式

```
parseArgs(mode=dev) → 兜底 NODE_ENV=development（未设置时） → scanRoutes(.ts) → sortRoutes → detectRouteConflicts
  → extractSchemasForRoutes → schemaRegistry.loadManifest
  → startServer → onReady → startWatcher（全量重建 schema）
```

### start 模式

```
parseArgs(mode=start) → 兜底 NODE_ENV=production（未设置时） → import dist/faapi-routes.js → hydrateRoutes（加载中间件）
  → sortRoutes → detectRouteConflicts
  → readManifestFile(dist/faapi-schema.js) → remapManifestKeys → schemaRegistry.loadManifest
  → startServer → onReady
```

start 模式不扫描文件系统：路由清单由 build 时序列化生成，启动时 import 读取并水合
（按 middlewarePaths 重新加载中间件文件，还原洋葱模型与注入器）。

## NODE_ENV 兜底

`faapi` 自己的 dev/prd 模式由命令词决定，不依赖 `NODE_ENV`。但启动时会按 mode 兜底设置 `NODE_ENV`（仅在未显式设置时）：

- `faapi` / `faapi dev` → `NODE_ENV=development`
- `faapi start` → `NODE_ENV=production`

目的：同步给生态下游。部分框架/库（如 Next.js 运行时 20+ 处）直接读 `process.env.NODE_ENV` 做分支判断，faapi 主动设置可让 `@faapi/next` 等集成插件无需自己推导 mode。

不覆盖用户意图：若用户显式 `NODE_ENV=test faapi start`，则保持 `test`，faapi 仅在未设置时回退。`FAAPI_ENV` 优先级不变（`FAAPI_ENV > NODE_ENV > 'development'`），仅用于加载环境配置文件。

## 相关模块

- `parseArgs.ts` - 解析参数，识别 dev/start 命令词
- `scanRoutes.ts` - dev 模式扫描路由
- `generateRoutes.ts` - prd 模式读取路由清单并水合
- `generateSchema.ts` - prd 模式加载 schema 模块
- `startServer.ts` - 启动服务
