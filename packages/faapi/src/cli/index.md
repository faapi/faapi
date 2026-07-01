# index (CLI)

一句话概括：CLI 入口脚本，分发 dev/start/build 命令。

## 为什么需要

作为 `faapi` 命令的入口点，接收命令行参数，分发到对应命令，处理顶层错误。

**命令分发**：
- `faapi build` → 调用 `buildCommand`（编译到 `dist/`，不启动服务器）
- `faapi` / `faapi dev` → dev 模式，调用 `startCommand`（由 `parseArgs` 解析出 `mode: 'dev'`）
- `faapi start` → 生产模式，调用 `startCommand`（由 `parseArgs` 解析出 `mode: 'start'`）

## 配置文件加载

路由文件由 esbuild 编译为 `.js` 产物（`.faapi/dev/` 或 `dist/`），运行时不再 import `.ts`。

`faapi.config.ts` 由 `loadConfig` 用 esbuild 编译为临时 `.mjs` 后 import（写入系统临时目录，不污染用户项目），无需 tsx：

- **bundle: true**：跟随 import 链，本地相对导入会被打包进来
- **packages: 'external'**：第三方依赖与 `@faapi/*` 保持 external，从用户 `node_modules` 解析
- **内容哈希缓存**：同一 `.ts` 配置文件内容未变化时跳过编译，复用产物
- `.js` / `.mjs` 配置文件直接 import，不走 esbuild

**别名处理**：tsconfig `paths` 别名（如 `@/lib/db`）在编译时由 esbuild onLoad 插件重写为产物相对路径，运行时无需 paths resolve hook。

## 使用场景

- 用户执行 `faapi` 或 `faapi dev`（dev 模式，路由走 esbuild 产物，config.ts 由 esbuild 编译）
- 用户执行 `faapi start`（生产模式，路由走 dist 产物，config.ts 由 esbuild 编译）
- 用户执行 `faapi build`（构建，不加载 config.ts，路由由 esbuild 编译）
- Node.js 解析 shebang 执行

## 相关模块

- `startCommand.ts` - 执行启动逻辑（dev/start 模式）
- `buildCommand.ts` - 构建逻辑（build 模式，含 esbuild 别名重写插件）
- `parseArgs.ts` - 参数解析（识别 dev/start 命令词）
- `compileRoutes.ts` - dev/build 模式编译 TypeScript
- `loadConfig.ts` - 加载 faapi.config.ts（esbuild 编译 .ts → 临时 .mjs → import）
