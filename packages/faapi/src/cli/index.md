# index (CLI)

一句话概括：CLI 入口脚本，分发 dev/start/build 命令。

## 为什么需要

作为 `faapi` 命令的入口点，接收命令行参数，分发到对应命令，处理顶层错误。

**命令分发**：
- `faapi build` → 调用 `buildCommand`（编译到 `dist/`，不启动服务器）
- `faapi` / `faapi dev` → dev 模式，注册 tsx 后调用 `startCommand`
- `faapi start` → 生产模式，不注册 tsx，直接调用 `startCommand`（由 `parseArgs` 解析出 `mode: 'start'`）

## tsx 注册

新架构下路由文件由 esbuild 编译为 `.js` 产物（`.faapi/dev/` 或 `dist/`），运行时不再 import `.ts`，**不再需要 tsx 即时转译路由文件**。

但 `faapi.config.ts` 仍由 `loadConfig` 直接 import，需要 tsx 处理 `.ts`。因此 dev/start 模式仍注册 tsx，仅用于加载配置文件：

- **build 模式**：不加载 `faapi.config.ts`，不注册 tsx
- **dev/start 模式**：注册 tsx（仅影响 `.ts` 配置文件，路由产物 `.js` 不受影响）

tsx 使用官方 API（`tsx/esm/api` 的 `register()`），作为外部依赖（tsup `external`），dev 模式下从用户 `node_modules` 解析，避免 tsx+esbuild 被打包进 ESM 产物后 esbuild 的 CJS `require('fs')` 在 ESM 下报错。

**预加载检测**：若用户已通过 `node --import tsx` 预加载 tsx（如 `package.json` 的 dev script），则跳过 `register`，避免 Node 24 的 `ERR_REQUIRE_CYCLE_MODULE`（`register('tsx/esm')` 与 `--import tsx` 同时使用会循环依赖）。检测 `process.execArgv` 和 `NODE_OPTIONS` 是否含 `tsx`。

**别名处理**：tsconfig `paths` 别名（如 `@/lib/db`）在编译时由 esbuild onLoad 插件重写为产物相对路径，运行时无需 paths resolve hook。`registerPathsHook` 已移除。

## 使用场景

- 用户执行 `faapi` 或 `faapi dev`（dev 模式，注册 tsx 加载 config.ts，路由走 esbuild 产物）
- 用户执行 `faapi start`（生产模式，注册 tsx 加载 config.ts，路由走 dist 产物）
- 用户执行 `faapi build`（构建，不注册 tsx，路由由 esbuild 编译）
- 用户通过 `node --import tsx .../dist/cli/index.js` 启动（dev 模式，跳过 tsx register）
- Node.js 解析 shebang 执行

## 相关模块

- `startCommand.ts` - 执行启动逻辑（dev/start 模式）
- `buildCommand.ts` - 构建逻辑（build 模式，含 esbuild 别名重写插件）
- `parseArgs.ts` - 参数解析（识别 dev/start 命令词）
- `compileRoutes.ts` - dev/build 模式编译 TypeScript
