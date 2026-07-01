---
"@faapi/faapi": patch
---

支持 tsconfig `paths` 别名解析，dev/build/start 三种模式均无需额外配置。

**编译时别名重写**：esbuild `onLoad` 插件在编译 `.ts` 时把别名 specifier（如 `@/lib/db`）重写为产物相对路径（`.js` 后缀），运行时无需 loader。dev 编译到 `.faapi/dev/`，build 编译到 `dist/`，别名均在编译时处理。

**编译范围**：扫描整个 `appDir` 下的 `.ts`（排除 `*.test.ts` / `*.e2e.test.ts` / `*.d.ts`），覆盖路由、中间件、以及被别名引用的依赖文件。

无 tsconfig / paths 时插件不启用，无副作用。

新增模块：`utils/readTsconfig.ts`、`utils/resolveAlias.ts`、`cli/compileRoutes.ts`（含别名重写 esbuild 插件）。
