# compileOnDemand

一句话概括：dev 模式按需编译（Vite 风格）——启动时只编译配置 + 生成路由清单，handler.js / zod.js 在首次请求时才触发编译/生成，配合 mtime 缓存复用未变更的产物。

## 为什么需要

dev 模式如果在启动时全量编译所有 `src/**/*.ts` + 全量生成 `zod.js`，启动耗时与 watch 重建耗时会随项目体积线性增长——而启动后真正被访问的路由往往只是一小部分。Vite 的核心思想是「按需编译」——只在请求到达时才编译被访问的模块，让 dev 启动近乎瞬开。

`compileOnDemand` 把这一思想引入 faapi：

- **启动零编译**：dev 启动只编译 config + 生成路由清单（`faapi-routes.js`），handler.js 与 zod.js 均不预生成
- **首次请求触发**：handler.js 由 `loadRouteModule` 先调 `ensureCompiled` 编译再 import；zod.js 由 `createServer` 在 `validateInput` 之前触发生成
- **闭包感知 mtime 缓存复用**：入口 + 依赖闭包逐文件比对产物与源码 mtime，全部 fresh 时零编译跳过，有 stale 只编译 stale 集（仅比对入口不足以证明产物可用——见「mtime 缓存的边界」）
- **缓存失效**：watcher 文件变化时清除内存缓存 + 删除 stale zod.js，下次请求按需重建

prod 模式（`node dist/main`）不启用按需编译——build 阶段已固化全部产物，import 失败即报错。

## 使用场景

- `faapi dev` / `faapi`：启动时设置 `setDevOnDemandEnabled(true)` + `setDevDist('.faapi')`
- 请求到达 `loadRouteModule`：先 `ensureCompiled` 编译源码（handler.js 不存在或 stale 时触发）→ import 产物
- 请求到达 `createServer.handleRequest`：zod.js 不存在或 stale → `ensureSchemaGenerated` 生成 → 继续 `validateInput`
- watcher 文件变化 → `reloadRoutes` 调 `deleteSchemaFiles` + `clearCompiledFiles` + `clearGeneratedSchemas` 失效缓存

## 模块标记 + DevOnDemandState 封装

原本散落的 4 个模块级可变状态（`devOnDemandEnabled` / `devDistDir` / `compiledFiles` / `generatedSchemas`）+ 2 个 mutex Map 封装到 `DevOnDemandState` 单例对象，避免全局污染 + 便于测试隔离。

```ts
interface DevOnDemandState {
  enabled: boolean;
  distDir: string | undefined;
  compiledFiles: Set<string>;
  generatedSchemas: Set<string>;
  inFlightCompilations: Map<string, Promise<void>>;      // handler.js 编译 mutex
  inFlightSchemaGenerations: Map<string, Promise<void>>; // zod.js 生成 mutex
}

const state: DevOnDemandState = createDevOnDemandState();
```

- `setDevOnDemandEnabled(true)` / `setDevDist('.faapi')` —— devCommand 启动时调用
- `isDevOnDemandEnabled()` / `getDevDist()` —— loadRouteModule / createServer 读取
- `_resetDevOnDemandState()` —— **仅测试用**，清空所有缓存 + mutex + 标记位，便于测试隔离

`isDevOnDemandEnabled()` 是全局开关——`loadRouteModule` / `createServer` 据此判断是否启用按需编译回退。prod 模式始终为 `false`。

## 并发去重（mutex）

dev 模式下，watcher 触发 reload + 并发请求同时进来时，可能两个请求同时发现产物 stale 都触发编译——esbuild 自身有并发保护，但重复调用浪费资源且可能写入冲突。

`ensureCompiled` / `ensureSchemaGenerated` 用 in-flight Promise Map 做并发去重：

- 同一 sourceAbsPath / schemaPath 的并发请求共享同一 in-flight Promise
- 第一个请求触发编译/生成，注册 Promise 到 Map
- 第二个请求 `await` 已注册的 Promise，返回 `false`（表示「别的请求已触发，本次不重复触发」）
- watcher 触发 clear 时同步清空 in-flight Map，避免旧 Promise 永久阻塞

失败语义：第一个请求编译失败时，第二个请求 `await` 会捕获但**不抛错**，让自己按正常流程重试（避免连锁失败）。

## handler.js 按需编译

### ensureCompiled

```ts
async function ensureCompiled(
  sourceAbsPath: string,
  rootDir: string,
  dist: string,
): Promise<boolean>
```

调用方：`loadRouteModule`（import 前）+ `loadWsHandler`（WS 升级时）+ `bootstrap`/`devCommand`/`createDevApp`（bootstrap、agent、task 加载链）+ `loadToolModule`/`loadPlugins`（tool、本地 TS 插件）。

四层处理（命中即跳过）：

1. **mutex 命中**：`inFlightCompilations.has(sourceAbsPath)` → await 后返回 `false`（别的请求正在编译）
2. **内存 Set 命中**：`compiledFiles.has(sourceAbsPath)` → 跳过（最快路径，稳态请求零 fs 访问）
3. **依赖闭包逐文件新鲜度检查**：`collectRelativeImports` 收集闭包后，入口与每个闭包文件各自比对产物/源码 mtime——产物存在且 `mtimeMs ≥ 源码 mtimeMs` 的文件复用
4. **全部 fresh → 零编译跳过；有 stale → 只编译 stale 集** → 加入 Set

**为什么入口产物 fresh 也要走闭包检查**：mtime 只能证明入口产物不过期，证明不了传递依赖。dev 停机期间依赖源码被改（本机重构 / git pull 他人提交）后重启，入口产物仍 fresh，旧入口产物会 import 陈旧依赖产物；而 config 闭包在每次启动时总会被 `compileConfig` 重编译为最新——两路产物新旧混编：导出面变更即 ESM 链接错误（`does not provide an export named ...`，报错点距根因很远），仅内部实现变更则静默跑旧代码。依赖闭包新增文件（旧产物未 import 的新模块）同样由闭包收集覆盖。

**依赖闭包**：`bundle: false` 逐文件编译不分析 import 关系，只编译 handler 单文件时，handler 引用的共享模块（如 `import { db } from '../../lib/db'`）没有产物，首次请求 import 即 `ERR_MODULE_NOT_FOUND`。因此第 3 步用 `collectRelativeImports`（见 [collectImports.md](./collectImports.md)，覆盖相对 import 与 tsconfig paths 别名）收集 src 内传递依赖。src 外依赖不收集（outbase=src 语义限制，与 watcher 增量编译一致）。

返回 `true` 表示实际触发了编译（含仅编译 stale 依赖闭包的场合），`false` 表示跳过（已编译过 / 全部产物已最新 / 源文件不存在 / 别的请求正在编译）。**编译失败时抛错**（带原始 cause），由调用方错误处理链接管，不静默吞错。

### 路径反推

`prodSourcePathToProductPath(sourceAbsPath, rootDir, dist)` 把源码绝对路径推算为产物绝对路径：

- 源码 `<rootDir>/src/api/hello/handler.ts` → 产物 `<rootDir>/<dist>/api/hello/handler.js`
- 仅 `src/` 前缀的源码可推算（其他前缀返回 `null`）

### 缓存失效

| API | 时机 | 行为 |
| --- | --- | --- |
| `clearCompiledFiles()` | `reloadRoutes` 调用 | 清空「已编译」标记 + in-flight mutex Map |

`reloadRoutes` 统一调 `clearCompiledFiles()`，全量清空缓存（watcher 文件变化后所有路由都可能受影响，单文件失效意义不大）+ 同步清 mutex 避免旧 Promise 永久阻塞。

### ensureMiddlewaresCompiled

```ts
async function ensureMiddlewaresCompiled(
  middlewarePaths: string[],  // 中间件产物绝对路径（scanRoutes 收集）
  rootDir: string,
): Promise<void>
```

调用方：`createServer`（HTTP 首次请求）+ `handleWsUpgrade`（WS 握手），在 `loadMergedMiddlewares` import 产物之前调用。

dev 按需模式下中间件产物在首次请求前不存在——若不先编译，import 即 `ERR_MODULE_NOT_FOUND`。通过 `prodPathToSourcePath` 反推源码路径后走 `ensureCompiled`（含依赖闭包，覆盖 middlewares.ts 引用的共享模块）。编译失败直接冒泡（请求 500，onError 可感知）——中间件产物缺失/损坏属显式失败场景，不做空 bundle 降级。prod 模式（按需开关关闭）直接返回——产物由 build 固化。

## zod.js 按需生成

### ensureSchemaGenerated

```ts
async function ensureSchemaGenerated(
  schemaPath: string,
  routeFilePath: string,
  routes: RouteManifest,
  rootDir: string,
  dist: string,
): Promise<boolean>
```

调用方：`createServer.handleRequest`，在 `validateInput` 之前调用（仅 `isDevOnDemandEnabled()` 为 true 时）。

参数说明：

- `schemaPath`：zod.js 绝对路径（由 `getRuntimeSchemaPath(route.filePath, dist, rootDir)` 计算）
- `routeFilePath`：`route.filePath`（dev/prod 模式下均为产物路径，如 `.faapi/api/hello/handler.js`）
- `routes`：完整路由清单（用于过滤同文件的所有方法——一个 handler.ts 可能导出 GET/POST/WS 多个方法）

四层处理（与 `ensureCompiled` 一致）：

1. **mutex 命中**：`inFlightSchemaGenerations.has(schemaPath)` → await 后返回 `false`
2. **内存 Set 命中**：`generatedSchemas.has(schemaPath)` → 跳过
3. **闭包感知 mtime 复用**：zod.js 存在且 `mtimeMs ≥ 源码 mtimeMs` 且依赖闭包内源文件均不晚于 zod.js → 加入 Set 跳过（闭包检查仅在前半条件满足时执行——缺失/stale 直接走生成，不付闭包扫描开销）。zod.js 内容内联跨文件类型（checker 解析完整 RuntimeType，每个 zod.js 自包含），仅凭 handler mtime 不足以证明 schema 最新——依赖类型在 dev 停机期间被改时旧 schema 会按旧类型校验（静默错）
4. **zod.js 不存在或 stale**：
   - 用 `prodPathToSourcePath` 把产物 route.filePath 反推源码 .ts 路径
   - 过滤同文件所有路由，把产物 filePath 改回源码 filePath（`generateSchemaFiles` 内部 AST 分析需要源码 .ts 路径）
   - 调 `generateSchemaFiles(sourceRoutes, rootDir, dist)` 生成 → 加入 Set

同进程内的跨文件类型解析依赖 AST Program 缓存（`invalidateProgramCache()` 清理）——watcher 每次文件变化经 `reloadRoutes` 清理，重启场景新进程天然为空。

返回 `true` 表示实际触发了生成，`false` 表示跳过（已生成过 / 产物已最新 / 源文件不存在 / 别的请求正在生成）。**生成失败时抛错**（带原始 cause），由 `createServer` 错误处理链接管，不静默吞错。

### deleteSchemaFiles

```ts
async function deleteSchemaFiles(
  routes: RouteManifest,
  rootDir: string,
  dist: string,
): Promise<void>
```

调用方：`reloadRoutes`（仅按需模式下）。

watcher 文件变化后，旧 zod.js 可能 stale（类型引用变化、字段重命名等）。删除后下次请求触发 `ensureSchemaGenerated` 重新生成。

仅删除 zod.js 文件，不删除 `faapi-helpers.js`（其内容确定性不变，重复生成无意义）。

### prodPathToSourcePath

```ts
function prodPathToSourcePath(
  prodAbsPath: string,
  rootDir: string,
  dist: string,
): string
```

产物路径反推源码路径：

- 产物 `<rootDir>/<dist>/api/hello/handler.js` → 源码 `<rootDir>/src/api/hello/handler.ts`
- 反推规则：去 `<dist>/` 前缀 → 加 `src/` 前缀 → `.js` → `.ts`（.ts 不存在时回退 .js，兼容用户直接放 .js 源码的少见场景）
- **映射缓存**：dev 按需模式下每请求都会调用，映射结果按产物路径缓存（`sourcePathCache` Map），稳态请求零 fs 访问；`clearCompiledFiles()`（reloadRoutes 时调用）一并清空——源文件新建/删除后映射重建

`ensureSchemaGenerated` 与 `loadRouteModule` 都用它把 `route.filePath`（产物路径）反推源码路径。

### 缓存失效

| API | 时机 | 行为 |
| --- | --- | --- |
| `clearGeneratedSchemas()` | `reloadRoutes` 调用 | 清空「已生成」标记 + in-flight mutex Map |

`reloadRoutes` 在按需模式下顺序：`deleteSchemaFiles` → `clearGeneratedSchemas`（先删文件再清缓存，下次请求触发重新生成）。

## 完整请求链路

```
请求到达 → matchRoute 命中 → loadRouteModule(absoluteFilePath, method, rootDir)
  ├─ isDevOnDemandEnabled()：
  │    ├─ prodPathToSourcePath(filePath) → 源码 .ts 路径
  │    ├─ ensureCompiled(sourcePath, rootDir, dist)
  │    │    ├─ inFlight / compiledFiles.has → return false
  │    │    ├─ 依赖闭包逐文件 mtime 检查 → 全 fresh → return false（零编译）
  │    │    └─ 有 stale → compileDevRoutes({ files: stale 集 }) → return true
  │    └─ 再 importWithCacheBust(filePath)（先编译后 import，避免 import 缺失
  │       文件污染 Vite SSR 内部状态）
  └─ 非 dev 按需：直接 importWithCacheBust(filePath)，失败即报错
→ resolveInput(method, request)
→ getRuntimeSchemaPath(route.filePath, dist, rootDir) → schemaPath
→ isDevOnDemandEnabled() + getDevDist()
  └─ ensureSchemaGenerated(schemaPath, route.filePath, routes, rootDir, dist)
       ├─ inFlight / generatedSchemas.has → return false
       ├─ zod.js fresh（入口 + 依赖闭包 mtime）→ return false
       └─ prodPathToSourcePath → 过滤同文件路由 → generateSchemaFiles → return true
→ validateInput(schemaPath, method, inputType, input)
→ invokeHandler(handler, ctx, body, middlewares, injectors)
```

## 与 watcher / reloadRoutes 的协作

```
watcher 文件变化（debounce 100ms）
  → compileDevRoutes({ files: 变化文件 })   // 增量编译
  → compileConfig({ rootDir, dist })         // 重生成 faapi-config.js
  → app.reloadRoutes()
       ├─ setLoadTimestamp(Date.now())         // ESM import 绕过缓存
       ├─ invalidateMiddlewareCache()
       ├─ invalidateProgramCache()
       ├─ invalidateSchemaCache()
       ├─ clearCompiledFiles()                 // 清按需编译缓存
       ├─ scanRoutes(rootDir, patterns, dist)  // 重新扫描（仅读源码 + 正则提取方法名）
       ├─ sortRoutes(routes)
       ├─ if (isDevOnDemandEnabled()):
       │    ├─ deleteSchemaFiles(sorted, rootDir, dist)  // 删 stale zod.js
       │    └─ clearGeneratedSchemas()                   // 清按需生成缓存
       └─ ctx.updateRoutes(sorted, wsRoutes)  // 更新 server 路由引用
```

下次请求到达时，`loadRouteModule` 先调 `ensureCompiled` → 检测到 mtime fresh（watcher 已编译）→ 跳过编译 → import 新产物。

## mtime 缓存的边界

- **首次冷启动**：所有 handler.js / zod.js 都不存在 → 第一次请求触发编译/生成（约 50ms 单文件延迟）
- **watcher 已编译**：handler.js 存在且 mtime ≥ 源码 → 闭包逐文件检查复用，零编译跳过
- **watcher 文件变化**：源码 mtime 更新 → ensureCompiled 检测到 stale → 重新编译；同时 reloadRoutes 已 clearCompiledFiles + invalidateProgramCache，确保不命中内存缓存
- **手编辑源码后立即请求（watcher 未触发）**：源码 mtime > 产物 mtime → ensureCompiled 检测到 stale → 重新编译
- **dev 停机期间依赖变更（重启后入口产物仍 fresh）**：仅比对入口 mtime 会漏判——入口产物照旧 import 陈旧依赖产物，与启动期被 `compileConfig` 重编译的 config 闭包产物新旧混编（导出面变更即 ESM 链接错误，内部变更则静默跑旧代码）。闭包逐文件检查覆盖：发现 stale 依赖 → 只重编译 stale 集
- **依赖闭包新增文件**：旧入口产物未 import 新模块产物 → 首次请求 `ERR_MODULE_NOT_FOUND`。闭包收集同样覆盖（新文件无产物 → 视为 stale 编译）
- **zod 跨文件类型变更（handler 未改）**：zod.js 内容内联跨文件类型，依赖源码 mtime 晚于 zod.js → 重新生成（Program 缓存由 reloadRoutes 清理 / 重启后新进程天然为空）
- **成本口径**：闭包扫描（`collectRelativeImports` 读源码 + 正则提取 import）只发生在每入口每进程首次调用（内存 Set 命中后不再发生，且 zod 侧仅在前半 fresh 条件满足时执行）；全部 fresh 时零 esbuild 调用

## 相关模块

- [loadRouteModule](../loaders/loadRouteModule.md) — handler.js 先调 `ensureCompiled` 编译再 import
- [handleWsUpgrade](../server/handleWsUpgrade.md) — WS 升级时调 `ensureCompiled`（通过 `loadWsHandler`）
- [createServer](../server/createServer.md) — `validateInput` 之前调 `ensureSchemaGenerated`
- [createDevApp](./createDevApp.md) — `reloadRoutes` 调 `deleteSchemaFiles` + `clearGeneratedSchemas` + `clearCompiledFiles`
- [devCommand](./devCommand.md) — 启动时 `setDevOnDemandEnabled(true)` + `setDevDist('.faapi')`
- [watcher](./watcher.md) — 增量编译变化的文件，调 `app.reloadRoutes()` 触发缓存失效
- [generateSchemaFiles](./generateSchemaFiles.md) — `ensureSchemaGenerated` 内部调它生成 zod.js
- [compileDevRoutes](./compileDevRoutes.md) — `ensureCompiled` 内部调它单文件编译
