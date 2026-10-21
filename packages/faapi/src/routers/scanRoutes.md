# scanRoutes

一句话概括：扫描文件系统，生成路由清单。**Vite 风格**——仅读源码 + 正则提取方法名，零 import handler.js / middlewares.js，让 dev 启动近乎瞬开。

## 为什么需要

faapi 的核心理念是"文件系统即路由"，需要将目录结构转换为路由清单。用户通过 CLI 指定 pattern，系统扫描匹配的文件，生成可用于路由匹配的数据结构。

旧版 `scanRoutes` 启动时全量 import handler.js + middlewares.js 拿方法名和中间件，dev 启动慢、按需编译无法实现。新版改为：

- **方法名提取**：正则匹配源码 `export function GET/POST/...` / `export const GET = ...`，不 import 模块
- **中间件路径收集**：从路由目录向上查找 `middlewares.ts`，仅收集路径不加载（由 `hydrateRoutes` / dev 启动流程按需加载）
- **零 import**：启动时只读源码 + 正则，handler.js 加载延后到 `loadRouteModule` 请求阶段（详见 [compileOnDemand](../cli/compileOnDemand.md)）

## 使用场景

- `faapi dev` / `faapi build` 启动时扫描 `src/api/**/*.ts`
- `reloadRoutes` 热替换时重新扫描（dev 模式 watcher 触发）
- 根据 glob pattern 过滤路由文件
- 将文件路径转换为 URL 路径

## 文件类型与 dist 参数

`scanRoutes` 接受可选的 `dist` 参数（`dist` 或 `.faapi`）：

- **传入 dist（dev/build 模式）**：扫描源码 `.ts` 文件列表，**正则提取方法名**（不 import 模块）。`filePath` 保持源码路径（如 `src/api/hello/handler.ts`），AST schema 提取需要 `.ts`。中间件路径收集为产物 `middlewares.js` 绝对路径（打平 src/ 前缀），由 `loadMergedMiddlewares` 加载。
- **不传 dist（旧模式，CLI 不再使用）**：扫描源码 `.ts`，中间件直接加载源码 `.ts/.js`（依赖 esbuild 即时转译，仅 e2e/测试保留）。

中间件文件查找逻辑：
- 传入 dist：查找产物 `middlewares.js`（已编译）
- 不传 dist：优先 `.ts`，回退 `.js`

### 产物路径打平 src 前缀

`toProdFilePath`（实现位于 [utils/prodPaths.ts](../utils/prodPaths.md)）将源码相对路径转为产物相对路径时，会剥离 `src/` 前缀，与 `compileDevRoutes` / `compileBuildRoutes` 的 `outbase` 设置一致：

- 源码：`src/api/hello/handler.ts`
- 产物：`<dist>/api/hello/handler.js`（去掉 `src/` 前缀）

## 方法名提取（正则）

`HTTP_OR_WS_EXPORT_RE` 匹配源码中导出的 HTTP 方法或 WS 函数：

```ts
const HTTP_OR_WS_EXPORT_RE = new RegExp(
  String.raw`export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|WS)\b`,
  'g',
);
```

支持语法：

- `export function GET() {}`
- `export async function POST() {}`
- `export const GET = () => {}` / `export const GET = async () => {}`
- `export function WS() {}`

不通过运行时 import 提取方法名，避免启动时全量加载 handler 模块（Vite 风格：路由发现与 handler 加载解耦，handler.js 按需编译/导入）。

## 中间件路径收集

`collectMiddlewarePaths(routeFilePath, rootDir, dist)` 从路由文件所在目录向上逐级查找 `middlewares.ts`（源码），返回从根到路由目录的中间件文件**绝对路径列表**（不加载模块）。

设计意图：scanRoutes 不再启动时全量 import middlewares.js，仅收集路径；实际的中间件加载延后到 `hydrateRoutes` / 请求阶段（与 prod 的 hydrateRoutes 一致）。这样 dev 启动时 zero import，启动速度接近 Vite。

路径选择规则（与 `generateRoutes.extractMiddlewarePaths` 一致）：

- dist 传入：返回**产物** middlewares.js 绝对路径（打平 src/ 前缀，存在性检查源码 .ts）
- dist 不传：返回**源码** middlewares.ts/.js 绝对路径（兼容无 dist 的旧调用方，如 testServer）

### loadMergedMiddlewares

`loadMergedMiddlewares(middlewarePaths)` 按路径列表加载并合并中间件（根在前，路由目录在后）。

scanRoutes 的中间件加载策略：

- **dist 模式（dev/build）**：scanRoutes 只收集 `middlewarePaths`，不调用 `loadMergedMiddlewares`。中间件加载延后到 `createServer` / `handleWsUpgrade` 请求阶段（Vite 风格按需加载）。
- **无 dist 模式（testServer/单测）**：scanRoutes 直接调用 `loadMergedMiddlewares` 预加载源码中间件并塞入 `route.middlewares`（保持向后兼容）。

合并语义：

- 子级中间件追加在父级之后（洋葱模型：后注册的中间件在内层）
- 子级注入器覆盖父级同名注入器

## 相关模块

- `parseRouteFile.ts` - 解析文件路径
- `sortRoutes.ts` - 排序扫描结果
- `routeTypes.ts` - 返回类型定义
- `compileDevRoutes.ts` / `compileBuildRoutes.ts` - 编译源码到产物（dev/build 模式前置步骤）
- `importWithCacheBust.ts` - ESM cache bust 加载
- `compileOnDemand.ts` - dev 按需编译模式（依赖 scanRoutes 的零 import 特性）
- `loadMiddlewares.ts` - 中间件加载与缓存
