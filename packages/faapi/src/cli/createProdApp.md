# createProdApp

一句话概括：prod 模式应用启动 API——委托 `createAppBase` 并仅返回 `AppBase`（不含 dev 的 `reloadRoutes`/缓存失效能力）。

## 为什么需要

prod 模式不需要热替换，直接读 `dist/` 产物启动。`faapi build` 生成 `dist/main.js` 启动入口（零入口设计：内部 `import { createProdApp } from '@faapi/faapi'` + `listen`），`node dist/main` 调用 `createProdApp` 完成启动。

`createProdApp` 是 `createAppBase` 的薄包装：调 `createAppBase` 取 `app`，丢弃 `ctx`（prod 不需要 `updateRoutes`）。这保证 dev/prod 走完全一致的读产物代码路径，差异仅由 `FAAPI_OUT_DIR` 驱动。

## 使用场景

- `faapi build` 生成的 `dist/main.js` 内部调用
- 编程式调用场景（自定义启动器、测试场景）
- `createApp`（`createProdApp` 的向后兼容别名）供旧代码使用

```bash
faapi build                # 生成 dist/main.js（内部 import createProdApp）
node dist/main             # 调 createProdApp + listen
```

## API

```ts
function createProdApp(options?: CreateAppOptions): Promise<ProdApp>
```

`ProdApp` 即 `AppBase`（`listen`/`close`/`inject`），无额外方法。`CreateAppOptions` 从 `createAppCore` re-export。

## 相关模块

- `createAppCore.ts` - `createAppBase` 共享编排核心，本函数直接委托
- `createApp.ts` - `createProdApp` 的向后兼容别名（`export { createProdApp as createApp }`）
- `buildCommand.ts` - `faapi build` 生成 `dist/main.js` 模板，内部引用 `createProdApp`
- `createDevApp.ts` - dev 模式对应物，基于同一个 `createAppBase` 增加 `reloadRoutes`
