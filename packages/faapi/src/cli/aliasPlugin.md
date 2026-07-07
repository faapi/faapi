# aliasPlugin

一句话概括：esbuild import specifier 重写插件（dev/build/config 编译器共用），在 `onLoad` 阶段把源码 import/export 中的**别名**（tsconfig.paths）和**相对无后缀** specifier 替换为产物相对路径（带 `.js` 后缀），使 `bundle: false` 模式下运行时无需 loader。

## 为什么需要

两类 specifier 在 `bundle: false` 逐文件编译模式下会原样保留到产物 `.js`，运行时 Node.js ESM loader 无法解析：

1. **tsconfig paths 别名**（如 `@/*` → `./src/*`）：编译期约定，运行时不存在
2. **相对路径无后缀**（如 `./base`、`../utils/helper`）：TypeScript `moduleResolution: Bundler` 允许不写后缀，但 Node.js ESM 不做后缀推断，必须显式 `.js`

`aliasPlugin` 通过 `onLoad` 钩子介入：读取源文件后，用正则匹配 `from '...'` 和 `import('...')` 的 specifier，按类型处理：

- **相对 specifier**（`./`、`../`）：解析到实际源文件，重写为产物相对路径（POSIX 风格 + `.js` 后缀）。已带 `.js`/`.mjs`/`.cjs` 后缀的不处理（视为产物路径）
- **别名 specifier**（非相对/绝对/协议）：调 `resolveAlias` 解析候选路径，命中则重写为产物相对路径

绝对路径（`/`）、`file:` URL、`node:` 协议不处理，交 esbuild 默认。

## 使用场景

- `compileDevRoutes` 编译 `.ts` → `.faapi/**/*.js`（逐文件，`bundle: false`）时挂载本插件
- `compileBuildRoutes` 编译 `.ts` → `dist/**/*.js`（逐文件，`bundle: false`）时挂载本插件
- `compileConfig` 步骤 1 编译 `faapi.config.ts` → `dist/faapi.config.js`（逐文件，`bundle: false`）时挂载本插件
- 无 tsconfig 或 tsconfig 无 `paths` 时，`buildAliasPlugins` 仍返回含本插件的数组（相对路径重写不依赖 tsconfig）

## 覆盖的 import 形式

- `import { x } from 'alias'` / `import { x } from './base'`
- `export { x } from 'alias'`（含 `from`，被同一正则匹配）
- `import('alias')` / `import('./base')`（动态 import）

## 相对 specifier 重写规则

| 源码 specifier | 实际文件 | 产物 specifier | 说明 |
|----------------|----------|----------------|------|
| `./base` | `./base.ts` | `./base.js` | 无后缀 → 解析 + 加 `.js` |
| `./lib/errors` | `./lib/errors.ts` | `./lib/errors.js` | 无后缀 → 解析 + 加 `.js` |
| `./lib` | `./lib/index.ts` | `./lib/index.js` | 目录 → 解析 index |
| `./base.ts` | `./base.ts` | `./base.js` | 源后缀 → 产物后缀 |
| `./base.js` | — | `./base.js`（不变） | 已是产物后缀，不处理 |
| `./base.mjs` | — | `./base.mjs`（不变） | 已是产物后缀，不处理 |
| `../utils/helper` | `../utils/helper.ts` | `../utils/helper.js` | 父目录同理 |

解析失败（文件不存在）时 specifier 原样保留，交 esbuild/Node 报错。

## API

| 函数 | 说明 |
|------|------|
| `toProdExtension(filePath)` | 源文件后缀转产物后缀：`.ts`/`.tsx`/`.jsx` → `.js`，其余原样 |
| `createAliasPlugin(config)` | 构造 esbuild `Plugin`，重写相对 specifier + 别名 specifier |
| `buildAliasPlugins(rootDir)` | 读 tsconfig 并构造插件数组（始终返回含本插件，相对路径重写不依赖 tsconfig） |

## 相关模块

- `compileDevRoutes.ts` - dev 编译时调 `buildAliasPlugins` 挂载 specifier 重写
- `compileBuildRoutes.ts` - build 编译时调 `buildAliasPlugins` 挂载 specifier 重写
- `compileConfig.ts` - config 编译时调 `buildAliasPlugins` 挂载 specifier 重写
- `resolveAlias.ts`（utils）- 按 tsconfig paths 解析别名 specifier 为候选路径
- `readTsconfig.ts`（utils）- 读取并解析 tsconfig 的 paths 配置
