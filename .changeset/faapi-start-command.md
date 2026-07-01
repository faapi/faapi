---
"@faapi/faapi": minor
---

新增 `faapi start` 命令，显式区分 dev/prd 启动模式；build 时生成路由清单，start 时读取清单+水合，不再扫描文件系统；修复 `faapi build` 未分发、未设默认 patterns 的 bug。

## 新增

**`faapi start` 命令**：启动生产服务器，加载 `dist/faapi-routes.js` 路由清单 + `dist/faapi-schema.js` schema（需先 `faapi build`），不依赖 `NODE_ENV`，不扫描文件系统。

```bash
faapi build    # 构建（编译 .ts + 生成路由清单 + schema 模块）
faapi start    # 启动生产服务器（读清单+水合，不 scanRoutes）
```

命令体系：

| 命令 | 模式 | 行为 |
|------|------|------|
| `faapi` / `faapi dev` | dev | 扫描 `.ts`，watch，全量提取 schema |
| `faapi start` | prd | 读 `dist/faapi-routes.js` + `dist/faapi-schema.js`，水合中间件，不 watch |
| `faapi build` | 构建 | 编译 → `dist/*.js` + `dist/faapi-routes.js` + `dist/faapi-schema.js` |

**路由清单生成与水合**：
- `faapi build` 序列化路由元数据为 `dist/faapi-routes.js`（ESM 模块），含 `middlewarePaths`（中间件文件绝对路径列表，根在前）
- `faapi start` import 读取清单后 `hydrateRoutes`：按 `middlewarePaths` 加载中间件文件，还原洋葱模型与注入器（函数无法序列化，需重新加载）
- 水合逻辑与 dev 模式 `scanRoutes.findMergedMiddlewares` 完全对齐：父级在前子级追加，子级注入器覆盖父级同名

## Breaking change

**dev/prd 模式不再通过 `NODE_ENV=production` 切换**。原 `NODE_ENV=production faapi` 改为 `faapi start`。

**`FAAPI_ENV` 优先级调整**：从 `NODE_ENV > FAAPI_ENV` 改为 `FAAPI_ENV > NODE_ENV > 'development'`。`NODE_ENV`/`FAAPI_ENV` 仅用于加载环境配置文件（`faapi.config.{env}.ts`），不再兼管 dev/prd 模式切换。

**`NODE_ENV` 兜底设置**：`faapi`/`faapi dev` 启动时若 `NODE_ENV` 未设置则设为 `development`，`faapi start` 启动时若未设置则设为 `production`（仅在未显式设置时回退，不覆盖用户意图）。目的是同步给生态下游（如 Next.js 运行时 20+ 处直接读 `process.env.NODE_ENV` 做分支判断），让 `@faapi/next` 等集成插件无需自己推导 mode。

## Bug 修复

- `faapi build` 之前未在 CLI 入口分发（命令存在但从未被调用），现已修复
- `parseBuildArgs` 未设默认 patterns，导致只编译 middlewares 不编译路由文件，现已修复
- `scanRoutes` 硬编码 `handler.ts`/`middlewares.ts`，prd 模式扫描 `.js` 失败，现已支持双扩展名
- prd 模式 schema manifest key 与运行时 route.filePath 不匹配（绝对路径 .ts vs 相对路径 .js），现已通过 `remapManifestKeys` 对齐
- `extractMiddlewarePaths` 把绝对路径传给按相对路径设计的 `toProdFilePath`，导致中间件 prd 路径错误（`dist/Users/...`），现已先转相对再转换
- `faapi build` 丢弃 `wsRoutes`，现已保留并序列化到路由清单

