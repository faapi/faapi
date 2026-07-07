# devCommand

一句话概括：`faapi dev` 的完整流程——编译 TypeScript、生成产物三元组、调用 `createDevApp()` 启动 dev 应用、启动文件 watcher 实现热替换。

## 为什么需要

dev 模式与 `faapi build`（产线构建）为两套独立代码路径，仅共享工具级函数（`compileDevRoutes`/`compileConfig` 等）。dev 模式调用 `createDevApp`（含 `reloadRoutes` 热替换），prod 模式由 `node dist/main`（运行 `faapi build` 生成的启动入口）调用 `createProdApp`（精简），dev/prod 入口完全分离。

框架采用零入口设计——用户无需编写 `main.ts`：dev 由 `faapi dev` 内部编排，prod 由 `faapi build` 自动生成 `dist/main.js` 启动入口。

`devCommand` 是 CLI 端的薄编排层，负责生成与 `faapi build` 一致的产物三元组（只是 outDir 为 `.faapi/dev`），让 `createDevApp` 走完全统一的读产物路径：

1. 设置 `FAAPI_OUT_DIR=.faapi/dev` + `NODE_ENV=development`（仅未显式设置时兜底）
2. `compileConfig` 编译配置源码 → `.faapi/dev/faapi-config.js`
3. `loadConfig(rootDir, '.faapi/dev')` 读应用行为配置，CLI 选项或环境变量读 `appDir`
4. `compileDevRoutes` 编译 `.ts` → `.faapi/dev/**/*.js`（esbuild 逐文件，含别名重写）
5. `generateRouteArtifacts` 生成 `.faapi/dev/faapi-routes.js` + 各 handler 的 `zod.js`
6. `createDevApp({ rootDir, port })` + `app.listen()` 启动 dev 应用（含 reloadRoutes 热替换能力）
7. `startWatcher({ rootDir, appDir, app })`（文件变化时增量编译 + 重生成 config + 调 `app.reloadRoutes()`）

CLI 选项（`--port` / `--appDir`）优先于环境变量（`PORT` / `FAAPI_APP_DIR`）。

## 使用场景

- `faapi` 或 `faapi dev`：开发模式，编译 + 生成产物 + 启动 dev 应用 + watch 热替换
- 源码目录通过环境变量 `FAAPI_APP_DIR` 配置（默认 `src`，设为 `.` 表示根目录）

## 与 createDevApp 的协作

`devCommand` 直接调用 `createDevApp()` 获取 app 实例。devCommand 持有 app 引用后直接传给 `startWatcher`，watcher 文件变化时调用 `app.reloadRoutes()` 实现热替换。

`createDevApp()` 通过 `FAAPI_OUT_DIR` 读 dev 产物，无需任何 dev/prod 模式判断。

## generateRouteArtifacts

`devCommand` 导出 `generateRouteArtifacts(rootDir, appDir, patterns)` 函数，生成路由产物：

1. `scanRoutes` 扫描路由（扫描源码 `.ts` 列表，import 产物 `.js` 拿方法名）
2. `sortRoutes` 排序
3. `serializeRoutes` + `writeRoutesModule` 生成 `faapi-routes.js`
4. `generateSchemaFiles` 生成各 handler 的 `zod.js`

与 `buildCommand` 的对应步骤一致，只是 outDir 为 `.faapi/dev`。

## 相关模块

- `createDevApp.ts` - `devCommand` 直接调用，启动 dev 应用（含 reloadRoutes）
- `createAppCore.ts` - `createDevApp` 的共享编排核心（createAppBase）
- `compileDevRoutes.ts` - `devCommand` 编译 TypeScript 到 `.faapi/dev/`
- `compileConfig.ts` - 编译配置源码为 `.faapi/dev/faapi-config.js`
- `generateRoutes.ts` - `generateRouteArtifacts` 生成 `faapi-routes.js`
- `generateSchemaFiles.ts` - `generateRouteArtifacts` 生成 `zod.js`
- `watcher.ts` - `devCommand` 启动的文件 watcher，接收 app 引用，调 `app.reloadRoutes()`
