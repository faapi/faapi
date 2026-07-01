---
"@faapi/faapi": minor
---

参考 Next.js 实现，重构 dev/build/start 架构：dev 和 build 都先编译 TypeScript 到中间产物，运行时只加载 `.js`，不再依赖 tsx 即时转译路由文件。

**dev 模式**（`faapi` / `faapi dev`）：
- esbuild 编译 `src/**/*.ts` → `.faapi/dev/**/*.js`（含别名重写）
- 扫描路由时 import 产物 `.js` 拿方法名，filePath 保持源码 `.ts`（AST schema 提取需要）
- 预生成 schema 到 `.faapi/dev/faapi-schema.js`，启动时加载（与 start 统一）
- watch 文件变化：增量编译变化的文件 + 全量扫描路由 + 重新生成 schema + 热替换路由

**build 模式**（`faapi build`）：
- esbuild 编译 `src/**/*.ts` → `dist/**/*.js`
- 生成 `dist/faapi-routes.js`（路由清单）+ `dist/faapi-schema.js`（schema 模块）

**start 模式**（`faapi start`）：
- 从 `dist/faapi-routes.js` 读取清单并水合（加载中间件）
- 从 `dist/faapi-schema.js` 加载 schema
- 不编译、不扫描文件系统

**tsx 调整**：路由文件不再需要 tsx 即时转译（esbuild 编译为 `.js` 产物）。tsx 仅保留用于加载 `faapi.config.ts`（dev/start 模式），build 模式不加载配置文件、不注册 tsx。

**watch 修复**：chokidar v4 移除了 glob 模式支持，改为监听整个 `appDir` 目录 + `ignored` 函数过滤（仅 `.ts` 文件，排除 `node_modules`/`.faapi`/`dist`/`.git`）。监听整个 appDir 比 glob 更合理：handler.ts 引用的 util.ts 变化也能触发重建。

**移除模块**：`registerPathsHook.ts`（别名在编译时由 esbuild 处理，运行时无需 paths resolve hook）。

新增模块：`cli/compileRoutes.ts`（统一编译模块，dev/build 共用）。
