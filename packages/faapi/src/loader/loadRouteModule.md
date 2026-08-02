# loadRouteModule

一句话概括：动态加载路由模块并提取 handler。dev 按需编译模式下，import 失败时触发 `ensureCompiled` 单文件编译后重试。

## 为什么需要

路由文件需要动态 import，提取对应的 handler 函数，校验导出是否合法。

dev 按需编译模式（Vite 风格）下，handler.js 不在启动时预编译——首次请求时 import 会失败，由 `loadRouteModule` 触发 `ensureCompiled` 单文件编译源码 → 重试 import。详见 [compileOnDemand](../cli/compileOnDemand.md)。

## 使用场景

- 请求到达时加载路由模块（HTTP 路由）
- 提取 GET/POST 等 handler
- 校验模块导出合法性
- dev 模式下 import 失败时触发按需编译

## 流程

```
loadRouteModule(filePath, method, rootDir)
  ├─ importWithCacheBust(filePath) 成功 → resolveExport + validateRouteModule
  └─ import 失败
       └─ if (isDevOnDemandEnabled() && rootDir):
            ├─ prodPathToSourcePath(filePath, rootDir, dist) → 源码 .ts 路径
            ├─ ensureCompiled(sourcePath, rootDir, dist)
            │    ├─ compiledFiles.has → 跳过
            │    ├─ mtime fresh → 跳过
            │    └─ compileDevRoutes({ files: [sourcePath] }) → 单文件编译
            └─ 编译成功 → 重试 importWithCacheBust → resolveExport + validateRouteModule
       （prod 模式：直接抛错，不重试）
```

`rootDir` 参数仅 dev 按需编译模式用（用于反推源码路径触发编译），prod 模式可省略。

## 相关模块

- `resolveExports.ts` - 提取导出
- `validateRouteModule.ts` - 校验模块
- `importWithCacheBust.ts` - ESM cache bust 加载
- `compileOnDemand.ts` - dev 按需编译核心（`ensureCompiled` + `isDevOnDemandEnabled` + `getDevDist` + `prodPathToSourcePath`）
