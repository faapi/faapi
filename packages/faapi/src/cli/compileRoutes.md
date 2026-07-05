# compileRoutes

一句话概括：统一的 TypeScript 编译模块，用 esbuild 把 `.ts` 编译到指定目录（dev→`.faapi/dev/`，build→`dist/`），复用 tsconfig paths 别名重写插件。

## 为什么需要

参考 Next.js 的实现，dev 和 build 都先编译 `.ts` 到中间产物（`.js`），再扫描路由和加载。这样：

- **移除 tsx 依赖**：运行时只加载 `.js`，路由文件由 esbuild 编译，`faapi.config.ts` 也由 esbuild 编译为临时 `.mjs`。
- **dev 和 build 加载逻辑统一**：都从 `.js` 产物加载，scanRoutes 只扫描 `.js`。
- **别名在编译时处理**：esbuild onLoad 插件重写别名 specifier 为产物相对路径，运行时无需 paths resolve hook。

## 使用场景

- `faapi dev`：编译 `src/**/*.ts` → `.faapi/dev/**/*.js`（打平 `src/` 前缀，如 `src/api/hello/handler.ts` → `.faapi/dev/api/hello/handler.js`），启动 server 加载产物，watch 时重编译。**逐文件编译**（`bundle: false`），启动快、增量编译。
- `faapi build`：**bundle 模式**，从 entries（handler.ts + middlewares.ts）出发跟随 import 链分析依赖树，`splitting` 把共享依赖提取为 chunk，`define` 替换 `process.env.NODE_ENV` 做常量折叠 + dead code elimination。产物 tree shaking，体积更小。
- watch 增量编译：只传入变化的文件列表（`files`，逐文件模式）。

## 两种编译模式

### 1. 逐文件模式（默认，`bundle: false`）

每个 `.ts` 独立编译为 `.js`，esbuild 不分析 import 关系。传入 `files` 或全量扫描 `appDir/**/*.ts` 作为 entryPoints。

适用 dev 模式：启动快、增量编译、产物结构清晰。

### 2. bundle 模式（`entries` 非空 或 `bundle: true`）

esbuild 从 `entries` 出发跟随 import 链分析依赖树：

- `splitting: true`：共享依赖（如 `utils.ts`）自动提取为 chunk 文件，被多个 entry 复用，避免重复打包。
- `define: { 'process.env.NODE_ENV': '"production"' }`：编译时把 `process.env.NODE_ENV` 替换为 `'production'` 字面量，使 `if ("production" !== 'production')` 变为 `if (false)`。
- `minifySyntax: true`：删除 `if (false) {...}` 等死分支（不缩短变量名、不压缩空白，保留可读性）。
- 跨文件 dead code elimination：`utils.ts` 里没被任何 entry import 的 export 会被删除。

> **define 与 minifySyntax 的关系**：`define` 只做字面量替换，把 `process.env.NODE_ENV` 变成 `'production'`。
> 但 `if (false) { ... }` 块内的死代码默认不会被 esbuild 删除——死分支删除属于 minify 的一部分。
> 因此 `faapi build` 同时启用 `define` 和 `minifySyntax`：前者做替换，后者做删除，两者配合完成完整的 dead code elimination。
> `minifySyntax` 只做语法层面压缩（删死分支、合并声明），不缩短变量名、不压缩空白，产物仍便于调试。

适用 build 模式：tree shaking、产物更小、`NODE_ENV` 替换 + 死分支删除。

### entries 与 files 互斥

- `entries`：bundle 模式入口文件列表（绝对路径）。
- `files`：逐文件模式文件列表（绝对路径，用于增量编译）。
- 两者不能同时传入；`splitting` 依赖 bundle 模式。

### 产物结构打平 appDir 前缀

esbuild 的 `outbase` 设为 `appDir`（通常是 `src`），使产物去掉 appDir 前缀：

- `src/api/hello/handler.ts` → `<outDir>/api/hello/handler.js`

好处：产物路径与 `urlPath`（`/api/hello`）更对齐，`appDir='.'` 时 outbase 回退到 rootDir（源码在根目录的场景）。

bundle 模式下 `splitting` 会额外生成 `chunk-<hash>.js`（共享依赖），esbuild 自动重写各 entry 的 import 路径指向 chunk，运行时无需手动处理。

## 相关模块

- `buildCommand.ts` - build 命令调用 compileRoutes 编译到 dist/
- `devCommand.ts` - dev 命令调用 compileRoutes 编译到 .faapi/dev/
- `watcher.ts` - watch 时调用 compileRoutes 重编译变化文件
- `readTsconfig.ts` - 读取 tsconfig paths 配置
- `resolveAlias.ts` - 别名解析（编译时调用）
