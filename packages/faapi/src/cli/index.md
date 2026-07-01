# index (CLI)

一句话概括：CLI 入口脚本，分发 dev/start/build 命令。

## 为什么需要

作为 `faapi` 命令的入口点，接收命令行参数，分发到对应命令，处理顶层错误。

**命令分发**：
- `faapi build` → 调用 `buildCommand`（构建，不启动服务器）
- `faapi` / `faapi dev` → dev 模式，注册 tsx 后调用 `startCommand`
- `faapi start` → 生产模式，不注册 tsx，直接调用 `startCommand`（由 `parseArgs` 解析出 `mode: 'start'`）

**tsx 注册**（仅 dev 模式需要）：
dev 模式下需注册 tsx，让 `import('.ts')` 能正常加载用户路由文件。使用 tsx 官方 API（`tsx/esm/api` 的 `register()`），内部自动构造 `MessageChannel` 传给 `module.register`，满足 tsx 4.22+ 的 `initialize` 钩子要求。tsx 作为外部依赖（tsup `external`），dev 模式下从用户 `node_modules` 解析，避免 tsx+esbuild 被打包进 ESM 产物后 esbuild 的 CJS `require('fs')` 在 ESM 下报错。

**start 模式跳过 tsx**：start 加载的是 `dist/*.js`（已 build），不需要 tsx。通过命令词 `start` 判断，不依赖 `NODE_ENV`。

**预加载检测**：若用户已通过 `node --import tsx` 预加载 tsx（如 `package.json` 的 dev script），则跳过 `register`，避免 Node 24 的 `ERR_REQUIRE_CYCLE_MODULE`（`register('tsx/esm')` 与 `--import tsx` 同时使用会循环依赖）。检测 `process.execArgv` 和 `NODE_OPTIONS` 是否含 `tsx`。

## 使用场景

- 用户执行 `faapi` 或 `faapi dev`（dev 模式，内部 register tsx）
- 用户执行 `faapi start`（生产模式，不加载 tsx）
- 用户执行 `faapi build`（构建，分发到 buildCommand）
- 用户通过 `node --import tsx .../dist/cli/index.js` 启动（dev 模式，跳过 register）
- Node.js 解析 shebang 执行

## 相关模块

- `startCommand.ts` - 执行启动逻辑（dev/start 模式）
- `buildCommand.ts` - 构建逻辑（build 模式）
- `parseArgs.ts` - 参数解析（识别 dev/start 命令词）
