# compileRoutes（已拆分）

> 本模块已按编译模式拆分为 `compileDevRoutes.ts`（dev 逐文件编译）和 `compileBuildRoutes.ts`（build bundle 编译）。两者共享 `readTsconfig.ts` 和 `resolveAlias.ts` 提供的别名重写插件。

## 为什么需要

参考 Next.js 的实现，dev 和 build 都先编译 `.ts` 到中间产物（`.js`），再扫描路由和加载。这样：

- **移除 tsx 依赖**：运行时只加载 `.js`，路由文件由 esbuild 编译，`faapi.config.ts` 也由 esbuild 编译为临时 `.mjs`。
- **dev 和 build 加载逻辑统一**：都从 `.js` 产物加载，scanRoutes 只扫描 `.js`。
- **别名在编译时处理**：esbuild onLoad 插件重写别名 specifier 为产物相对路径，运行时无需 paths resolve hook。

## 使用场景

- `faapi dev`：调 `compileDevRoutes` 编译 `src/**/*.ts` → `.faapi/dev/**/*.js`（打平 `src/` 前缀）。**逐文件编译**（`bundle: false`），启动快、增量编译。
- `faapi build`：调 `compileBuildRoutes` 做 **bundle 模式**编译,从 entries（handler.ts + middlewares.ts）出发跟随 import 链分析依赖树,`splitting` 提取共享依赖为 chunk,`define` 替换 `process.env.NODE_ENV` 做常量折叠 + dead code elimination。
- watch 增量编译：watcher 调 `compileDevRoutes` 只传入变化的文件列表。

## 两种编译模式

### 1. 逐文件模式（compileDevRoutes，`bundle: false`）

每个 `.ts` 独立编译为 `.js`，esbuild 不分析 import 关系。传入 `files` 或全量扫描 `appDir/**/*.ts` 作为 entryPoints。

适用 dev 模式：启动快、增量编译、产物结构清晰。

### 2. bundle 模式（compileBuildRoutes，`bundle: true`）

esbuild 从 `entries` 出发跟随 import 链分析依赖树：

- `splitting: true`：共享依赖（如 `utils.ts`）自动提取为 chunk 文件，被多个 entry 复用，避免重复打包。
- `define: { 'process.env.NODE_ENV': '"production"' }`：编译时把 `process.env.NODE_ENV` 替换为 `'production'` 字面量，使 `if ("production" !== 'production')` 变为 `if (false)`。
- `minifySyntax: true`：删除 `if (false) {...}` 等死分支（不缩短变量名、不压缩空白，保留可读性）。
- 跨文件 dead code elimination：`utils.ts` 里没被任何 entry import 的 export 会被删除。

适用 build 模式：tree shaking、产物更小、`NODE_ENV` 替换 + 死分支删除。

### 产物结构打平 appDir 前缀

esbuild 的 `outbase` 设为 `appDir`（通常是 `src`），使产物去掉 appDir 前缀：

- `src/api/hello/handler.ts` → `<outDir>/api/hello/handler.js`

bundle 模式下 `splitting` 会额外生成 `chunk-<hash>.js`（共享依赖），esbuild 自动重写各 entry 的 import 路径指向 chunk。

## 相关模块

- `compileDevRoutes.ts` - dev 逐文件编译
- `compileBuildRoutes.ts` - build bundle 编译
- `buildCommand.ts` - build 命令调 compileBuildRoutes 编译到 dist/
- `devCommand.ts` - dev 命令调 compileDevRoutes 编译到 .faapi/dev/
- `watcher.ts` - watch 时调 compileDevRoutes 重编译变化文件
- `readTsconfig.ts` - 读取 tsconfig paths 配置
- `resolveAlias.ts` - 别名解析（编译时调用）
