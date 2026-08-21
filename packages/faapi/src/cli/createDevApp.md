# createDevApp

一句话概括：dev 模式应用启动 API——委托 `createAppBase` 并附加 `reloadRoutes`/`reloadTools` 热替换能力（重新扫描路由/tool + 按需模式下清缓存/删 stale zod.js + 更新 server 路由引用）。

## 为什么需要

dev 模式需要热替换：文件变更后 watcher 增量编译 `.ts` → `.faapi/*.js`，再调 `app.reloadRoutes()` 重新扫描路由并更新 server 引用，调 `app.reloadTools()` 重新扫描 tools 并重生成 `faapi-tools.js`，无需重启进程。

`createDevApp` 是 `createAppBase` 的薄包装：调 `createAppBase` 取 `app` 和 `ctx`，在 `app` 上挂载 `reloadRoutes`（内部用 `ctx.updateRoutes` 更新 server 路由引用）和 `reloadTools`（重生成 `faapi-tools.js`）。这保证 dev/prod 走完全一致的读产物代码路径，差异仅由 `FAAPI_DIST`（dev 固定 `.faapi`）驱动。

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
  reloadTools(): Promise<void>;
}

function createDevApp(options?: CreateAppOptions): Promise<DevApp>
```

`DevApp` 在 `AppBase`（`listen`/`close`/`inject`）基础上增加 `reloadRoutes` 和 `reloadTools`。`CreateAppOptions` 从 `createAppCore` re-export。

## reloadRoutes 流程

1. `setLoadTimestamp(Date.now())` — 更新模块加载时间戳（ESM import 绕过缓存）
2. `invalidateMiddlewareCache()` / `invalidateProgramCache()` / `invalidateSchemaCache()` — 清缓存（watcher 已重新生成产物）
3. `clearCompiledFiles()` — 清按需编译内存缓存（让被修改的 handler.js 下次请求触发重编译）
4. `scanRoutes(rootDir, patterns, dist)` — 重新扫描源码路由（不走 `faapi-routes.js` 重新 import，ESM 缓存难以可靠绕过；scanRoutes 仅读源码 + 正则提取方法名，零 import）
5. `sortRoutes(routes)`
6. **按需模式分支**（`isDevOnDemandEnabled()` 为 true）：
   - `deleteSchemaFiles(sorted, rootDir, dist)` — 删除 stale zod.js（类型引用变化等），下次请求触发 `ensureSchemaGenerated` 重新生成
   - `clearGeneratedSchemas()` — 清按需生成内存缓存
7. **非按需模式分支**（兼容旧路径）：`generateSchemaFiles(sorted, rootDir, dist)` 全量重新生成 zod.js
8. `ctx.updateRoutes` — 更新 `app.routes`/`app.wsRoutes` 和 `routesRef.current`/`routesRef.wsCurrent`（server 使用最新路由）

按需模式下 `reloadRoutes` 不全量生成 zod.js——保持「按需生成」策略，仅删 stale 文件 + 清缓存，下次请求按需重建。详见 [compileOnDemand](./compileOnDemand.md)。

## reloadTools 流程

1. `setLoadTimestamp(Date.now())` — 更新模块加载时间戳（让 `faapi-tools.js` 重新读取绕过 ESM 缓存）
2. `invalidateProgramCache()` — 清 Program 缓存（tool 源码可能变化，AST 需重新分析）
3. `scanTools(rootDir, TOOL_PATTERNS)` — 重新扫描 tools（零 import，仅读源码 + 正则提取函数名）
4. `generateToolArtifacts(tools, rootDir, dist, { skipSchema: isDevOnDemandEnabled() })` — 重生成 `faapi-tools.js`（含 AST 增强：description / inputTypeName）
   - 按需模式跳过 zod.js 生成——首次请求时按需生成（与 `reloadRoutes` 的策略一致）
   - 非按需模式全量生成 tool zod.js

与 `reloadRoutes` 的分工：`reloadRoutes` 管路由清单 + 路由 zod.js，`reloadTools` 管 tool 清单 + tool zod.js。两者独立重建，互不干扰。watcher 文件变化后先调 `reloadRoutes` 再调 `reloadTools`。

无 tool 文件时 `scanTools` 返回空列表，`generateToolArtifacts` 写入空清单（`export const tools = []`），开销极低。

## 相关模块

- `createAppCore.ts` - `createAppBase` 共享编排核心，本函数直接委托
- `createProdApp.ts` - prod 模式对应物（精简，无 `reloadRoutes`）
- `createApp.ts` - `createProdApp` 的向后兼容别名
- `devCommand.ts` - `faapi dev` 命令，内部调用 `createDevApp` + `listen` + 启动 watcher
- `watcher.ts` - 接收 app 引用，文件变更时调 `app.reloadRoutes()` 实现热替换
- `../router/scanRoutes.ts` - `reloadRoutes` 重新扫描路由（零 import，仅读源码 + 正则）
- `./compileOnDemand.ts` - 按需模式下的缓存失效与 stale zod.js 删除
- `./generateSchemaFiles.ts` - 非按需模式下 `reloadRoutes` 全量重新生成 zod.js
- `../tools/scanTools.ts` - `reloadTools` 重新扫描 tools（零 import，仅读源码 + 正则），导出 `TOOL_PATTERNS`
- `./generateToolArtifacts.ts` - `reloadTools` 重生成 `faapi-tools.js` + tool zod.js
