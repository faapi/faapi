# compileBuildRoutes

一句话概括：build 模式逐文件编译 TypeScript 源码到 `dist/` 产物（`bundle: false`），额外启用 `define` + `minifySyntax` 做编译期常量替换与死分支删除。（实现由 [compileSourceFiles](./compileSourceFiles.md) 提供，本模块为 build 模式薄封装：仅 `atomicWrite` / `production` 选项差异）

## 为什么需要

build 模式需要把 `src/**/*.ts` 编译为 `dist/**/*.js` 供生产运行时 `import` 加载。与 dev 模式采用相同的逐文件编译（`bundle: false`）策略，保证 `faapi.config.ts` 中的 `instanceof` 跨 config/routes 边界生效——bundle 模式会把 import 的项目模块 inline 进产物，导致 config 和 routes 各自打包出独立的项目类副本，运行时对象不同一。

build 模式特有需求：
- **编译期常量替换**：`define: { 'process.env.NODE_ENV': '"production"' }` 把源码中的 `process.env.NODE_ENV` 替换为 `"production"` 字面量
- **死分支删除**：`minifySyntax: true` 删除 `if (false) {...}` 等死分支（如 `if (process.env.NODE_ENV !== 'production') { console.log('debug') }` 在 build 产物中整个 if 分支被移除）
- **无需原子写**：build 是一次性编译，运行时不并发，用 esbuild 默认写即可

两者在 `bundle: false` 下均生效（单文件级别优化，不需要跨文件分析）。

## 使用场景

- `faapi build`：全量编译 `src/**/*.ts` → `dist/**/*.js`（打平 `src/` 前缀）

## 统一编译模式：逐文件编译（`bundle: false`）

每个 `.ts` 独立编译为 `.js`，esbuild 不分析 import 关系。

- 产物打平 `src/` 前缀：`src/api/hello/handler.ts` → `dist/api/hello/handler.js`（`outbase` 设为 `src`）
- 别名在编译时重写为相对路径（`aliasPlugin`），运行时无需 loader
- tree shaking 不可用（`bundle: false` 不分析跨文件引用图）——符合设计意图，保留所有 export 让 config/routes 共享同一运行时对象

**与 `compileDevRoutes` 的差异**：仅 `dist` 不同（build 为 `dist`，dev 为 `.faapi`），编译逻辑一致。build 额外启用 `define` + `minifySyntax`；dev 不传 `define`，`process.env.NODE_ENV` 运行时读取环境变量，便于热替换时环境变化。

## 相关模块

- [compileDevRoutes](./compileDevRoutes.md) — dev 模式逐文件编译（与 build 一致，仅 dist 不同，无 define/minifySyntax）
- [buildCommand](./buildCommand.md) — build 命令调本模块编译到 dist/
- [aliasPlugin](./aliasPlugin.md) — 别名重写插件
- [readTsconfig](./readTsconfig.md) — 读取 tsconfig paths 配置
