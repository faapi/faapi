# loadRouteModule

一句话概括：动态加载路由模块并提取 handler。dev 按需编译模式下，先 `ensureCompiled` 确保产物存在再 import，避免 import 不存在的文件。

## 为什么需要

路由文件需要动态 import，提取对应的 handler 函数，校验导出是否合法。

dev 按需编译模式（Vite 风格）下，handler.js 不在启动时预编译——首次请求时产物还不存在。为避免 import 不存在的文件污染 Vite SSR 内部状态（vitest 环境下会导致后续重试 import 仍失败），`loadRouteModule` 先调 `ensureCompiled` 确保产物已生成，再 import。详见 [compileOnDemand](../cli/compileOnDemand.md)。

## 使用场景

- 请求到达时加载路由模块（HTTP 路由）
- 提取 GET/POST 等 handler
- 校验模块导出合法性
- dev 模式下先触发按需编译再 import

## 流程

```
loadRouteModule(filePath, method, rootDir)
  ├─ if (isDevOnDemandEnabled() && rootDir):
  │    ├─ prodPathToSourcePath(filePath, rootDir, dist) → 源码 .ts 路径（映射缓存,稳态零 fs）
  │    ├─ ensureCompiled(sourcePath, rootDir, dist)
  │    │    ├─ compiledFiles.has → 跳过（内存 Set,每请求最快路径）
  │    │    ├─ 源文件不存在 → 返回 false（不在此处 existsSync,避免每请求冗余 IO）
  │    │    ├─ mtime fresh → 跳过
  │    │    └─ compileDevRoutes({ files: [sourcePath] }) → 单文件编译
  │    └─ 编译失败 → 抛 "Failed to compile route module"
  ├─ importWithCacheBust(filePath, bustViteCache=isDevOnDemandEnabled())
  │    └─ dev 按需模式：走 Node 原生 import + 时间戳 query 绕过 Vite SSR 缓存
  └─ resolveExport + validateRouteModule
```

`rootDir` 参数仅 dev 按需编译模式用（用于反推源码路径触发编译），prod 模式可省略。

## 为什么先编译再 import（而非 import 失败后重试）

旧版采用"import 失败 → 编译 → 重试 import"模式，在 CI（Linux）的 vitest 环境下复现失败：

- `vi.importActual` 首次 import 不存在的文件后，Vite SSR 内部状态被污染
- 编译创建文件后重试 import 仍命中失败缓存 → 500
- 加 cache-busting query 在 CI 上无效

改为"先编译再 import"彻底避免 import 不存在的文件，dev/prod 行为一致（先有产物再 import），仅在 dev 模式增加一次 `ensureCompiled` 调用（命中缓存时仅一次 `Set.has` 检查，零开销）。

## 相关模块

- `resolveExports.ts` - 提取导出
- `validateRouteModule.ts` - 校验模块
- `importWithCacheBust.ts` - ESM cache bust 加载（`bustViteCache` 参数：dev 按需模式下走 Node 原生 import）
- `compileOnDemand.ts` - dev 按需编译核心（`ensureCompiled` + `isDevOnDemandEnabled` + `getDevDist` + `prodPathToSourcePath`）
