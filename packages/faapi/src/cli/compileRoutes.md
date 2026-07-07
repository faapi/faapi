# compileRoutes（已拆分）

> 本模块已按编译模式拆分为 `compileDevRoutes.ts`（dev 逐文件编译）和 `compileBuildRoutes.ts`（build 逐文件编译）。两者共享 `readTsconfig.ts` 和 `resolveAlias.ts` 提供的别名重写插件。

## 为什么需要

参考 Next.js 的实现，dev 和 build 都先编译 `.ts` 到中间产物（`.js`），再扫描路由和加载。这样：

- **移除 tsx 依赖**：运行时只加载 `.js`，路由文件由 esbuild 编译，`faapi.config.ts` 也由 esbuild 编译为临时 `.mjs`。
- **dev 和 build 加载逻辑统一**：都从 `.js` 产物加载，scanRoutes 只扫描 `.js`。
- **别名在编译时处理**：esbuild onLoad 插件重写别名 specifier 为产物相对路径，运行时无需 paths resolve hook。

## 使用场景

- `faapi dev`：调 `compileDevRoutes` 编译 `src/**/*.ts` → `.faapi/dev/**/*.js`（打平 `src/` 前缀）。**逐文件编译**（`bundle: false`），启动快、增量编译。
- `faapi build`：调 `compileBuildRoutes` 做**逐文件编译**（`bundle: false`），与 dev 模式一致，扫描 `appDir/**/*.ts` → `dist/**/*.js`。不再使用 bundle 模式,以保证 `instanceof` 跨 config/routes 边界生效（详见 `compileConfig.md`）。
- watch 增量编译：watcher 调 `compileDevRoutes` 只传入变化的文件列表。

## 统一编译模式：逐文件编译（`bundle: false`）

dev 和 build 都采用 `bundle: false` 逐文件编译，每个 `.ts` 独立编译为 `.js`，esbuild 不分析 import 关系。

**为什么不用 bundle 模式**：bundle 模式会把 import 的项目模块 inline 进产物,导致 config 和 routes 各自打包出独立的项目类副本,`instanceof` 跨边界失效。逐文件编译保证每个源文件对应唯一一份产物,config 和 routes 共享同一运行时对象。

### dev 与 build 的差异

dev 和 build 编译逻辑一致,仅 `outDir` 不同。build 模式额外启用两个 esbuild 选项:

- **`define: { 'process.env.NODE_ENV': '"production"' }`**：编译期把 `process.env.NODE_ENV` 替换为 `"production"` 字面量
- **`minifySyntax: true`**：语法简化（`if (cond) { expr }` → `cond && expr`）+ 死分支删除（`if (false) {...}` 被移除）

两者在 `bundle: false` 下均生效（单文件级别优化,不需要跨文件分析）。配合使用可在编译期消除 dev-only 代码分支:

```ts
// 源码
if (process.env.NODE_ENV !== 'production') {
  console.log('debug');  // dev 时执行，build 时被删除
}

// build 产物（process.env.NODE_ENV → "production"，if ("production" !== "production") → if (false) → 删除）
// 整个 if 分支不存在
```

**tree shaking 不可用**：`bundle: false` 不分析跨文件引用图,未引用的 export 不会被删除。这符合设计意图——保留所有 export,让 config 和 routes 共享同一运行时对象。

### 产物结构打平 appDir 前缀

esbuild 的 `outbase` 设为 `appDir`（通常是 `src`），使产物去掉 appDir 前缀：

- `src/api/hello/handler.ts` → `<outDir>/api/hello/handler.js`

不再生成 `chunk-<hash>.js`（无 splitting,每个文件独立编译）。

## 相关模块

- `compileDevRoutes.ts` - dev 逐文件编译
- `compileBuildRoutes.ts` - build 逐文件编译（与 dev 一致,仅 outDir 不同）
- `buildCommand.ts` - build 命令调 compileBuildRoutes 编译到 dist/
- `devCommand.ts` - dev 命令调 compileDevRoutes 编译到 .faapi/dev/
- `watcher.ts` - watch 时调 compileDevRoutes 重编译变化文件
- `readTsconfig.ts` - 读取 tsconfig paths 配置
- `resolveAlias.ts` - 别名解析（编译时调用）
