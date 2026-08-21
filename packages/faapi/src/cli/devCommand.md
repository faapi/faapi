# devCommand

一句话概括：`faapi dev` 的完整流程——编译配置 + 生成路由清单 + 启用按需编译模式 + 调用 `createDevApp()` 启动 dev 应用 + 启动文件 watcher 实现热替换。

## 为什么需要

dev 模式与 `faapi build`（产线构建）为两套独立代码路径，仅共享工具级函数（`compileDevRoutes`/`compileConfig` 等）。dev 模式调用 `createDevApp`（含 `reloadRoutes` 热替换），prod 模式由 `node dist/main`（运行 `faapi build` 生成的启动入口）调用 `createProdApp`（精简），dev/prod 入口完全分离。

框架采用零入口设计——用户无需编写 `main.ts`：dev 由 `faapi dev` 内部编排，prod 由 `faapi build` 自动生成 `dist/main.js` 启动入口。

`devCommand` 是 CLI 端的薄编排层，负责生成与 `faapi build` 一致的产物三元组（只是 dist 为 `.faapi`），让 `createDevApp` 走完全统一的读产物路径：

1. 设置 `FAAPI_DIST=.faapi` + `NODE_ENV=development`（仅未显式设置时兜底）
2. 启用按需编译模式：`setDevOnDemandEnabled(true)` + `setDevDist('.faapi')`
3. `compileConfig` 编译配置源码 → `.faapi/faapi-config.js`
4. `loadConfig(rootDir, '.faapi')` 读应用行为配置
5. `generateRouteArtifacts` 生成 `.faapi/faapi-routes.js`（**仅路由清单，不编译 handler.js，不生成 zod.js**——按需模式）
6. `generateToolArtifactsForDev` 生成 `.faapi/faapi-tools.js`（**仅 tool 清单，不生成 tool zod.js**——按需模式）
7. `createDevApp({ rootDir, port })` + `app.listen()` 启动 dev 应用（含 reloadRoutes/reloadTools 热替换能力）
8. `startWatcher({ rootDir, app, devDist: '.faapi' })`（文件变化时增量编译 + 重生成 config + 调 `app.reloadRoutes()` + `app.reloadTools()`）

CLI 选项（`--port`）优先于环境变量（`PORT`）。

## Vite 风格按需编译

dev 启动时**只编译配置和路由清单**，不全量编译 handler.js / 生成 zod.js：

- **handler.js**：首次请求时由 `loadRouteModule` 先调 `ensureCompiled` 单文件编译再 import
- **zod.js**：首次请求时由 `createServer` 在 `validateInput` 之前调 `ensureSchemaGenerated` 生成
- **mtime 缓存**：watcher 已编译过的文件，首次请求时 mtime 复用跳过编译

详见 [compileOnDemand](./compileOnDemand.md)。

**与旧版（启动全量编译）的差异**：

| 步骤 | 旧版 | 新版（按需） |
| --- | --- | --- |
| 启动时编译 handler.js | 全量 `compileDevRoutes(src/**/*.ts)` | 跳过 |
| 启动时生成 zod.js | 全量 `generateSchemaFiles` | 跳过 |
| 首次请求延迟 | 即时（已编译） | 单文件编译约 50ms |
| 启动速度 | 慢（项目越大越慢） | 近乎瞬开（仅 config + 路由清单） |

## 使用场景

- `faapi` 或 `faapi dev`：开发模式，编译配置 + 生成路由清单 + 启动 dev 应用 + watch 热替换
- 源码目录固定为 `src`

## 与 createDevApp 的协作

`devCommand` 直接调用 `createDevApp()` 获取 app 实例。devCommand 持有 app 引用后直接传给 `startWatcher`，watcher 文件变化时调用 `app.reloadRoutes()` 实现热替换。

`createDevApp()` 通过 `FAAPI_DIST` 读 dev 产物，无需任何 dev/prod 模式判断。

## generateRouteArtifacts

`devCommand` 导出 `generateRouteArtifacts(rootDir, patterns, dist)` 函数，**仅生成路由清单**：

1. `scanRoutes` 扫描路由（读源码 + 正则提取方法名，零 import——详见 [scanRoutes](../router/scanRoutes.md)）
2. `sortRoutes` 排序
3. `serializeRoutes` + `writeRoutesModule` 生成 `faapi-routes.js`

**与 `buildCommand` 的差异**：build 阶段全量生成 zod.js（`generateSchemaFiles`），dev 阶段跳过（按需生成）。两者产物三元组结构一致，仅 zod.js 生成时机不同。

## generateToolArtifactsForDev

`devCommand` 导出 `generateToolArtifactsForDev(rootDir, dist)` 函数，**仅生成 tool 清单**：

1. `scanTools` 扫描 tools（读源码 + 正则提取函数名，零 import——详见 [scanTools](../tools/scanTools.md)）
2. `generateToolArtifacts` 生成 `faapi-tools.js`（`skipSchema: true`——按需模式跳过 zod.js）

与 `generateRouteArtifacts` 对称——dev 按需模式仅生成清单，tool zod.js 首次请求时按需生成。无 tool 文件时 `scanTools` 返回空列表，`generateToolArtifacts` 写入空清单。

## 相关模块

- [compileOnDemand](./compileOnDemand.md) — 按需编译核心：`ensureCompiled` / `ensureSchemaGenerated` / `deleteSchemaFiles`
- `createDevApp.ts` - `devCommand` 直接调用，启动 dev 应用（含 reloadRoutes/reloadTools）
- `createAppCore.ts` - `createDevApp` 的共享编排核心（createAppBase）
- `compileDevRoutes.ts` - 按需编译时由 `ensureCompiled` 单文件调用
- `compileConfig.ts` - 编译配置源码为 `.faapi/faapi-config.js`
- `generateRoutes.ts` - `generateRouteArtifacts` 生成 `faapi-routes.js`
- `generateSchemaFiles.ts` - 按需生成时由 `ensureSchemaGenerated` 单文件调用
- `../tools/scanTools.ts` - `generateToolArtifactsForDev` 扫描 tools（导出 `TOOL_PATTERNS`）
- `./generateToolArtifacts.ts` - `generateToolArtifactsForDev` 生成 `faapi-tools.js` + tool zod.js
- `watcher.ts` - `devCommand` 启动的文件 watcher，接收 app 引用，调 `app.reloadRoutes()` + `app.reloadTools()`
