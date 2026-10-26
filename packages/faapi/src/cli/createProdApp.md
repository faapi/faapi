# createProdApp

一句话概括：prod 模式应用启动（**框架内部模块，不公开导出**）——委托 `createAppBase` + 加载执行 `src/bootstrap.ts` 并返回 `AppBase`（不含 dev 的 reload*/缓存失效能力）。

> **框架内部模块（7.x 起不公开导出）**——仅供生成的 `dist/main.js`（`$start`）与 CLI 编排使用，业务不应直接调用。启动逻辑写 `src/bootstrap.ts`（见 [bootstrap](./bootstrap.md)）。

## 为什么需要

prod 模式不需要热替换，直接读 `dist/` 产物启动。`faapi build` 生成 `dist/main.js` 启动入口（零入口设计：内部 `import { loadEnv, $start } from '@faapi/faapi'`），`node dist/main` 调用 `$start` → `createProdApp` 完成启动。

`createProdApp` 是 `createAppBase` 的薄包装：调 `createAppBase` 取 `app` 与 `ctx`，加载执行 `src/bootstrap.ts`（app 已创建、事件未发射——业务订阅窗口，见 [bootstrap](./bootstrap.md)；bootstrap 抛错则 close 后上抛，不留孤儿单例），丢弃 `ctx`（prod 不需要 `updateRoutes`）。这保证 dev/prod 走完全一致的读产物代码路径，差异仅由 `FAAPI_DIST` 驱动。

## 使用场景

- `faapi build` 生成的 `dist/main.js` 经公开导出 `$start` 内部调用（`$` 前缀 = 框架内部标记，业务不应直接调用）
- `createProdApp` 本身**不公开导出**——业务零入口（启动逻辑写 `src/bootstrap.ts`）

```bash
faapi build                # 生成 dist/main.js（内部 import loadEnv + $start）
node dist/main             # 调 $start → createProdApp（+ bootstrap）→ listen
```

## API

```ts
// 内部模块——不进公开导出面（devCommand / $start 经相对路径引用）
function createProdApp(options?: CreateAppOptions): Promise<ProdApp>
```

`ProdApp` 即 `AppBase`（`on`/`listen`/`close`/`inject`），无额外方法。`CreateAppOptions` 从 `createAppCore` re-export。

## 相关模块

- `createAppCore.ts` - `createAppBase` 共享编排核心，本函数直接委托
- [bootstrap](./bootstrap.md) - `src/bootstrap.ts` 约定启动文件（本函数返回前加载执行）
- [start](./start.md) - `$start` 唯一公开启动导出（生成入口专用）
- `buildCommand.ts` - `faapi build` 生成 `dist/main.js` 模板（`$start`）
- `createDevApp.ts` - dev 模式对应物，基于同一个 `createAppBase` 增加 reload* + bootstrap（onDemand 编译）
