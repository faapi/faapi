# compileRoutes

一句话概括：统一的 TypeScript 编译模块，用 esbuild 把 `.ts` 编译到指定目录（dev→`.faapi/dev/`，build→`dist/`），复用 tsconfig paths 别名重写插件。

## 为什么需要

参考 Next.js 的实现，dev 和 build 都先编译 `.ts` 到中间产物（`.js`），再扫描路由和加载。这样：

- **移除 tsx 依赖**：运行时只加载 `.js`，不再需要 tsx 即时转译 `.ts`。
- **dev 和 build 加载逻辑统一**：都从 `.js` 产物加载，scanRoutes 只扫描 `.js`。
- **别名在编译时处理**：esbuild onLoad 插件重写别名 specifier 为产物相对路径，运行时无需 paths resolve hook。

## 使用场景

- `faapi dev`：编译 `src/**/*.ts` → `.faapi/dev/**/*.js`，启动 server 加载产物，watch 时重编译。
- `faapi build`：编译 `src/**/*.ts` → `dist/**/*.js`，不启动。
- watch 增量编译：只传入变化的文件列表。

## 相关模块

- `buildCommand.ts` - build 命令调用 compileRoutes 编译到 dist/
- `startCommand.ts` - dev 命令调用 compileRoutes 编译到 .faapi/dev/
- `watcher.ts` - watch 时调用 compileRoutes 重编译变化文件
- `readTsconfig.ts` - 读取 tsconfig paths 配置
- `resolveAlias.ts` - 别名解析（编译时调用）
