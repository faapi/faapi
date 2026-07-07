# index (CLI)

一句话概括：CLI 入口脚本，分发 dev/build 命令。

## 为什么需要

作为 `faapi` 命令的入口点，分发到对应命令，处理顶层错误。

**命令分发**：
- `faapi build` → 调用 `buildCommand`（bundle 编译到 `.faapi/build/` + 生成产物三元组 + 生成 `.faapi/build/main.js` 启动入口）
- `faapi` / `faapi dev` → 调用 `devCommand`（编译到 `.faapi/dev/` + 生成产物三元组 + 调 `createDevApp` 启动 dev 应用 + 启动 watcher）

## 零入口设计

框架采用零入口设计——用户无需编写 `main.ts`：
- dev：`faapi dev` 内部调 `createDevApp()` + `listen()`
- prod：`faapi build` 自动生成 `.faapi/build/main.js` 启动入口（内部 import `createProdApp` + `listen`），`node .faapi/build/main` 直接启动

用户自定义启动逻辑（初始化数据库、注册信号处理等）通过 `faapi.config.ts` 的 `lifecycle.onReady` / `onClose` 钩子实现，dev/prod 都执行。

`createApp` / `createProdApp` / `createDevApp` 主要供编程式调用场景使用（如自定义启动器），`.faapi/build/main.js` 内部也调用它们完成启动。

## 产物三元组

dev 和 prod 生成完全一致的产物三元组，差异仅由 `FAAPI_DIST` 环境变量驱动：

| 产物 | dev | prod |
|------|-----|------|
| `*.js`（路由/middleware 编译） | `.faapi/dev/**/*.js` | `.faapi/build/**/*.js` |
| `faapi-config.js`（配置合并产物） | `.faapi/dev/faapi-config.js` | `.faapi/build/faapi-config.js` |
| `faapi-routes.js`（路由清单） | `.faapi/dev/faapi-routes.js` | `.faapi/build/faapi-routes.js` |
| `zod.js`（schema 模块） | `.faapi/dev/**/zod.js` | `.faapi/build/**/zod.js` |

`faapi.config.ts` 由 `compileConfig` 用 esbuild 编译合并为单个 `faapi-config.js`（写入 dist），运行时 `loadConfig` 直接 import 产物，零编译、零合并：

- **bundle: true**：跟随 import 链，本地相对导入会被打包进产物
- **packages: 'external'**：第三方依赖与 `@faapi/*` 保持 external，从用户 `node_modules` 解析
- **内容哈希缓存**：同一 `.ts` 配置文件内容未变化时跳过编译，复用产物
- `.js` / `.mjs` 配置文件直接 import，不走 esbuild

**别名处理**：tsconfig `paths` 别名（如 `@/lib/db`）在编译时由 esbuild onLoad 插件重写为产物相对路径，运行时无需 paths resolve hook。

## 使用场景

- 用户执行 `faapi` 或 `faapi dev`（dev 模式：编译 + 生成产物 + 调 `createDevApp` 启动 + 启动 watcher）
- 用户执行 `faapi build`（构建到 `.faapi/build/` + 生成 `.faapi/build/main.js` 启动入口，不启动服务器）
- 用户执行 `node .faapi/build/main`（启动生产服务器，读 `.faapi/build/` 产物三元组）
- Node.js 解析 shebang 执行

## 相关模块

- `devCommand.ts` - dev 模式编排（设 `FAAPI_DIST` + 编译 + 生成产物 + 调 `createDevApp` + watcher）
- `buildCommand.ts` - 构建逻辑（bundle 编译 + 生成产物三元组到 `.faapi/build/` + 生成 `.faapi/build/main.js` 启动入口）
- `createAppCore.ts` - dev/prod 共享的 `createAppBase` 编排核心
- `createDevApp.ts` - dev 入口（含 reloadRoutes 热替换）
- `createProdApp.ts` - prod 入口（精简，由 `.faapi/build/main.js` 内部调用）
- `createApp.ts` - `createProdApp` 的向后兼容别名
- `compileDevRoutes.ts` / `compileBuildRoutes.ts` - dev/build 专用编译
- `compileConfig.ts` - 编译合并配置文件为 `faapi-config.js`
- `loadConfig.ts` - 加载 `faapi-config.js` 产物（统一读 dist）
