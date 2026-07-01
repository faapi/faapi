---
"@faapi/faapi": patch
---

修复 dev 启动时 tsx 4.22+ 抛 `tsx must be loaded with --import instead of --loader` 错误。

**根因**：tsx 4.22 的 `initialize` 钩子要求 `module.register` 传入非空 `data`（含 `MessagePort`），旧调用 `register('tsx/esm', parentURL)` 只传了 `parentURL`。

**修复**：改用 `node:module` 的 `register` + 手动构造 `MessageChannel` 传 `data`，满足 tsx 4.22 要求；同时检测 `--import tsx` 预加载，已预加载时跳过 `register`，避免 Node 24 的 `ERR_REQUIRE_CYCLE_MODULE`。

兼容两种启动方式：
- `faapi`（内部 register tsx）
- `node --import tsx .../dist/cli/index.js`（跳过 register，避免循环依赖）
