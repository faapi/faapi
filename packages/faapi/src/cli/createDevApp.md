# createDevApp

一句话概括：dev 模式应用启动 API——委托 `createAppBase` 并附加 `reloadRoutes` 热替换能力（重新扫描路由 + 重新生成 schema + 清缓存 + 更新 server 路由引用）。

## 为什么需要

dev 模式需要热替换：文件变更后 watcher 增量编译 `.ts` → `.faapi/*.js`，再调 `app.reloadRoutes()` 重新扫描路由并更新 server 引用，无需重启进程。

`createDevApp` 是 `createAppBase` 的薄包装：调 `createAppBase` 取 `app` 和 `ctx`，在 `app` 上挂载 `reloadRoutes`（内部用 `ctx.updateRoutes` 更新 server 路由引用）。这保证 dev/prod 走完全一致的读产物代码路径，差异仅由 `FAAPI_DIST`（dev 固定 `.faapi`）驱动。

## 使用场景

- `faapi dev` 内部调用（`devCommand` 持有 app 引用并传给 watcher）
- 编程式调用场景（自定义 dev 启动器、测试场景）

```ts
// devCommand.ts 内部
const app = await createDevApp({ rootDir });
await app.listen();
startWatcher({ rootDir, app, devDist: '.faapi' });
```

## API

```ts
interface DevApp extends AppBase {
  reloadRoutes(): Promise<void>;
}

function createDevApp(options?: CreateAppOptions): Promise<DevApp>
```

`DevApp` 在 `AppBase`（`listen`/`close`/`inject`）基础上增加 `reloadRoutes`。`CreateAppOptions` 从 `createAppCore` re-export。

## reloadRoutes 流程

1. `setLoadTimestamp(Date.now())` — 更新模块加载时间戳（ESM import 绕过缓存）
2. `invalidateMiddlewareCache()` / `invalidateProgramCache()` / `invalidateSchemaCache()` — 清缓存（watcher 已重新生成产物）
3. `scanRoutes(rootDir, patterns, dist)` — 重新扫描源码路由（不走 `faapi-routes.js` 重新 import，ESM 缓存难以可靠绕过）
4. `generateSchemaFiles` — 重新生成 `zod.js`
5. `ctx.updateRoutes` — 更新 `app.routes`/`app.wsRoutes` 和 `routesRef.current`/`routesRef.wsCurrent`（server 使用最新路由）

## 相关模块

- `createAppCore.ts` - `createAppBase` 共享编排核心，本函数直接委托
- `createProdApp.ts` - prod 模式对应物（精简，无 `reloadRoutes`）
- `createApp.ts` - `createProdApp` 的向后兼容别名
- `devCommand.ts` - `faapi dev` 命令，内部调用 `createDevApp` + `listen` + 启动 watcher
- `watcher.ts` - 接收 app 引用，文件变更时调 `app.reloadRoutes()` 实现热替换
- `../router/scanRoutes.ts` - `reloadRoutes` 重新扫描路由
- `./generateSchemaFiles.ts` - `reloadRoutes` 重新生成 zod.js
