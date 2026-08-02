# compileOnDemand

一句话概括：dev 模式按需编译（Vite 风格）——启动时只编译配置 + 生成路由清单，handler.js / zod.js 在首次请求时才触发编译/生成，配合 mtime 缓存复用未变更的产物。

## 为什么需要

旧版 `faapi dev` 启动时全量编译所有 `src/**/*.ts` + 全量生成 `zod.js`，项目变大时启动慢、watch 重建耗时高。Vite 的核心思想是「按需编译」——只在请求到达时才编译被访问的模块，让 dev 启动近乎瞬开。

`compileOnDemand` 把这一思想引入 faapi：

- **启动零编译**：dev 启动只编译 config + 生成路由清单（`faapi-routes.js`），handler.js 与 zod.js 均不预生成
- **首次请求触发**：handler.js 由 `loadRouteModule` import 失败时触发编译；zod.js 由 `createServer` 在 `validateInput` 之前触发生成
- **mtime 缓存复用**：产物存在且 mtime ≥ 源码 mtime 时跳过重新编译/生成，watcher 已编译过的文件首次请求时直接复用
- **缓存失效**：watcher 文件变化时清除内存缓存 + 删除 stale zod.js，下次请求按需重建

prod 模式（`node dist/main`）不启用按需编译——build 阶段已固化全部产物，import 失败即报错。

## 使用场景

- `faapi dev` / `faapi`：启动时设置 `setDevOnDemandEnabled(true)` + `setDevDist('.faapi')`
- 请求到达 `loadRouteModule`：handler.js 不存在或 stale → `ensureCompiled` 编译源码 → 重试 import
- 请求到达 `createServer.handleRequest`：zod.js 不存在或 stale → `ensureSchemaGenerated` 生成 → 继续 `validateInput`
- watcher 文件变化 → `reloadRoutes` 调 `deleteSchemaFiles` + `clearCompiledFiles` + `clearGeneratedSchemas` 失效缓存

## 模块标记

```ts
let devOnDemandEnabled = false;
let devDistDir: string | undefined;

setDevOnDemandEnabled(true);   // devCommand 启动时调用
setDevDist('.faapi');          // devCommand 启动时调用
isDevOnDemandEnabled();        // loadRouteModule / createServer 读取
getDevDist();                  // loadRouteModule / createServer 读取
```

`isDevOnDemandEnabled()` 是全局开关——`loadRouteModule` / `createServer` 据此判断是否启用按需编译回退。prod 模式始终为 `false`。

## handler.js 按需编译

### ensureCompiled

```ts
async function ensureCompiled(
  sourceAbsPath: string,
  rootDir: string,
  dist: string,
): Promise<boolean>
```

调用方：`loadRouteModule`（import 失败时）+ `loadWsHandler`（WS 升级时）。

三层缓存策略（命中即跳过）：

1. **内存 Set 命中**：`compiledFiles.has(sourceAbsPath)` → 跳过（最快路径）
2. **mtime 复用**：产物存在且 `mtimeMs ≥ 源码 mtimeMs` → 加入 Set 跳过（复用 watcher 已编译的产物）
3. **产物不存在或 stale**：调 `compileDevRoutes({ files: [sourceAbsPath] })` 单文件编译 → 加入 Set

返回 `true` 表示实际触发了编译（调用方据此决定是否重试 import），`false` 表示跳过（已编译过 / 产物已最新 / 源文件不存在）。**编译失败时抛错**（带原始 cause），由调用方错误处理链接管，不静默吞错。

### 路径反推

`prodSourcePathToProductPath(sourceAbsPath, rootDir, dist)` 把源码绝对路径推算为产物绝对路径：

- 源码 `<rootDir>/src/api/hello/handler.ts` → 产物 `<rootDir>/<dist>/api/hello/handler.js`
- 仅 `src/` 前缀的源码可推算（其他前缀返回 `null`）

### 缓存失效

| API | 时机 | 行为 |
| --- | --- | --- |
| `clearCompiledFiles()` | `reloadRoutes` 调用 | 清空所有「已编译」标记 |

`reloadRoutes` 统一调 `clearCompiledFiles()`，全量清空缓存（watcher 文件变化后所有路由都可能受影响，单文件失效意义不大）。

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

三层缓存策略（与 `ensureCompiled` 一致）：

1. **内存 Set 命中**：`generatedSchemas.has(schemaPath)` → 跳过
2. **mtime 复用**：zod.js 存在且 `mtimeMs ≥ 源码 mtimeMs` → 加入 Set 跳过
3. **zod.js 不存在或 stale**：
   - 用 `prodPathToSourcePath` 把产物 route.filePath 反推源码 .ts 路径
   - 过滤同文件所有路由，把产物 filePath 改回源码 filePath（`generateSchemaFiles` 内部 AST 分析需要源码 .ts 路径）
   - 调 `generateSchemaFiles(sourceRoutes, rootDir, dist)` 生成 → 加入 Set

返回 `true` 表示实际触发了生成，`false` 表示跳过（已生成过 / 产物已最新 / 源文件不存在）。**生成失败时抛错**（带原始 cause），由 `createServer` 错误处理链接管，不静默吞错。

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

`ensureSchemaGenerated` 与 `loadRouteModule` 都用它把 `route.filePath`（产物路径）反推源码路径。

### 缓存失效

| API | 时机 | 行为 |
| --- | --- | --- |
| `clearGeneratedSchemas()` | `reloadRoutes` 调用 | 清空所有「已生成」标记 |

`reloadRoutes` 在按需模式下顺序：`deleteSchemaFiles` → `clearGeneratedSchemas`（先删文件再清缓存，下次请求触发重新生成）。

## 完整请求链路

```
请求到达 → matchRoute 命中 → loadRouteModule(absoluteFilePath, method, rootDir)
  ├─ importWithCacheBust(filePath) 成功 → 直接用
  └─ import 失败 + isDevOnDemandEnabled()
       ├─ prodPathToSourcePath(filePath) → 源码 .ts 路径
       ├─ ensureCompiled(sourcePath, rootDir, dist)
       │    ├─ compiledFiles.has → return false
       │    ├─ mtime fresh → return false
       │    └─ compileDevRoutes({ files: [sourcePath] }) → return true
       └─ 编译成功 → 重试 importWithCacheBust(filePath)
→ resolveInput(method, request)
→ getRuntimeSchemaPath(route.filePath, dist, rootDir) → schemaPath
→ isDevOnDemandEnabled() + getDevDist()
  └─ ensureSchemaGenerated(schemaPath, route.filePath, routes, rootDir, dist)
       ├─ generatedSchemas.has → return false
       ├─ mtime fresh → return false
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

下次请求到达时，`loadRouteModule` import 失败（旧 handler.js 已被 watcher 重新编译但 cache bust 生效）→ `ensureCompiled` 检测到 mtime fresh（watcher 已编译）→ 跳过编译，直接 import。

## mtime 缓存的边界

- **首次冷启动**：所有 handler.js / zod.js 都不存在 → 第一次请求触发编译/生成（约 50ms 单文件延迟）
- **watcher 已编译**：handler.js 存在且 mtime ≥ 源码 → mtime 复用，跳过编译
- **watcher 文件变化**：源码 mtime 更新 → ensureCompiled 检测到 stale → 重新编译；同时 reloadRoutes 已 clearCompiledFiles，确保不命中内存缓存
- **手编辑源码后立即请求（watcher 未触发）**：源码 mtime > 产物 mtime → ensureCompiled 检测到 stale → 重新编译

## 相关模块

- [loadRouteModule](../loader/loadRouteModule.md) — handler.js import 失败时调 `ensureCompiled` + 重试
- [handleWsUpgrade](../server/handleWsUpgrade.md) — WS 升级时调 `ensureCompiled`（通过 `loadWsHandler`）
- [createServer](../server/createServer.md) — `validateInput` 之前调 `ensureSchemaGenerated`
- [createDevApp](./createDevApp.md) — `reloadRoutes` 调 `deleteSchemaFiles` + `clearGeneratedSchemas` + `clearCompiledFiles`
- [devCommand](./devCommand.md) — 启动时 `setDevOnDemandEnabled(true)` + `setDevDist('.faapi')`
- [watcher](./watcher.md) — 增量编译变化的文件，调 `app.reloadRoutes()` 触发缓存失效
- [generateSchemaFiles](./generateSchemaFiles.md) — `ensureSchemaGenerated` 内部调它生成 zod.js
- [compileDevRoutes](./compileDevRoutes.md) — `ensureCompiled` 内部调它单文件编译
