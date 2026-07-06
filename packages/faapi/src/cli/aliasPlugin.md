# aliasPlugin

一句话概括：esbuild 别名重写插件（dev/build 编译器共用），在 `onLoad` 阶段把源码 import/export 中的 tsconfig.paths 别名 specifier 替换为产物相对路径（带 `.js` 后缀），使 `bundle: false` 模式下运行时无需 loader。

## 为什么需要

tsconfig 的 `paths` 别名（如 `@/*` → `./src/*`）是编译期约定，运行时不存在。esbuild 在 `bundle: false`（dev 模式逐文件编译）模式下不递归解析依赖（`onResolve` 不触发），别名 import 会原样保留到产物 `.js` 中，运行时 Node.js ESM loader 无法解析而报错。

`aliasPlugin` 通过 `onLoad` 钩子介入：读取源文件后，用正则匹配 `from '...'` 和 `import('...')` 的 specifier，对非相对/绝对/`file:`/`node:` 的别名 specifier 调 `resolveAlias` 解析候选路径，命中则重写为产物相对路径（POSIX 风格 + `.js` 后缀），再交给 esbuild 转译。

bundle 模式（`faapi build`）下同样适用：`onLoad` 在 esbuild 解析前执行，别名被重写为相对路径后，esbuild 的 bundle 逻辑跟随重写后的路径分析依赖树。

## 使用场景

- `compileDevRoutes` 编译 `.ts` → `.faapi/dev/**/*.js`（逐文件，`bundle: false`）时挂载本插件
- `compileBuildRoutes` bundle 模式编译（`bundle: true`）时挂载本插件
- 无 tsconfig 或 tsconfig 无 `paths` 时，`buildAliasPlugins` 返回空数组（优雅降级为无别名插件）

## 覆盖的 import 形式

- `import { x } from 'alias'`
- `export { x } from 'alias'`（含 `from`，被同一正则匹配）
- `import('alias')`（动态 import）

相对路径（`./`）、绝对路径（`/`）、`file:` URL、`node:` 协议不处理，交 esbuild 默认。

## API

| 函数 | 说明 |
|------|------|
| `toProdExtension(filePath)` | 源文件后缀转产物后缀：`.ts`/`.tsx`/`.jsx` → `.js`，其余原样 |
| `createAliasPlugin(config)` | 构造 esbuild `Plugin`，按 `TsconfigPathsConfig` 重写别名 |
| `buildAliasPlugins(rootDir)` | 读 tsconfig 并构造插件数组；无 tsconfig 返回 `[]` |

## 相关模块

- `compileDevRoutes.ts` - dev 编译时调 `buildAliasPlugins` 挂载别名重写
- `compileBuildRoutes.ts` - build 编译时调 `buildAliasPlugins` 挂载别名重写
- `resolveAlias.ts`（utils）- 按 tsconfig paths 解析别名 specifier 为候选路径
- `readTsconfig.ts`（utils）- 读取并解析 tsconfig 的 paths 配置
