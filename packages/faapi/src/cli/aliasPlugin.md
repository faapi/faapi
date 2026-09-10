# aliasPlugin

一句话概括：esbuild import specifier 重写插件（dev/build/config 编译器共用），在 `onLoad` 阶段用 TypeScript AST 定位源码中真实的 import/export/动态 import 说明符，把**别名**（tsconfig.paths）和**相对无后缀** specifier 替换为产物相对路径（带 `.js` 后缀），使 `bundle: false` 模式下运行时无需 loader；**项目内无法解析的相对导入直接构建报错**，不静默放行。

## 为什么需要

两类 specifier 在 `bundle: false` 逐文件编译模式下会原样保留到产物 `.js`，运行时 Node.js ESM loader 无法解析：

1. **tsconfig paths 别名**（如 `@/*` → `./src/*`）：编译期约定，运行时不存在
2. **相对路径无后缀**（如 `./base`、`../utils/helper`）：TypeScript `moduleResolution: Bundler` 允许不写后缀，但 Node.js ESM 不做后缀推断，必须显式 `.js`

`aliasPlugin` 通过 `onLoad` 钩子介入：读取源文件后，按类型处理：

- **相对 specifier**（`./`、`../`）：解析到实际源文件，重写为产物相对路径（POSIX 风格 + `.js` 后缀）。已带 `.js`/`.mjs`/`.cjs` 后缀的不重写（视为产物路径）；`.js` 说明符在对应 `.js` 文件不存在时回退探测 `.ts`/`.tsx`/`.jsx` 源文件（`moduleResolution: Node16` 风格的 `import './x.js'` 实际指向 `x.ts`，产物必然有 `x.js`，不重写也不报错）
- **别名 specifier**（非相对/绝对/协议）：调 `resolveAlias` 解析候选路径，命中则重写为产物相对路径

绝对路径（`/`）、`file:` URL、`node:` 协议不处理，交 esbuild 默认。

**为什么用 AST 定位而不是正则**：正则匹配 `from '...'` 会误伤注释与字符串——注释掉的 `// import { x } from './deleted'`（指向已删除文件）会被当成真实导入，"解析失败即报错"的严格化会大面积误报，宽松化则会静默改写注释文本。TypeScript 解析器只给出真实的 `ImportDeclaration` / `ExportDeclaration` / 动态 `import()` 说明符及精确位置，注释与字符串天然安全，报错可定位到 file:line:column。

## 使用场景

- `compileDevRoutes` 编译 `.ts` → `.faapi/**/*.js`（逐文件，`bundle: false`）时挂载本插件
- `compileBuildRoutes` 编译 `.ts` → `dist/**/*.js`（逐文件，`bundle: false`）时挂载本插件
- `compileConfig` 步骤 1 编译 `faapi.config.ts` → `dist/faapi.config.js`（逐文件，`bundle: false`）时挂载本插件
- 无 tsconfig 或 tsconfig 无 `paths` 时，`buildAliasPlugins` 仍返回含本插件的数组（相对路径重写不依赖 tsconfig）

## 覆盖的 import 形式

- `import { x } from 'alias'` / `import { x } from './base'`
- `import './base'`（副作用导入，同样重写/报错）
- `export { x } from 'alias'` / `export * from './base'`
- `import('alias')` / `import('./base')`（动态 import，仅字面量实参）

## 相对 specifier 重写规则

| 源码 specifier | 实际文件 | 产物 specifier | 说明 |
|----------------|----------|----------------|------|
| `./base` | `./base.ts` | `./base.js` | 无后缀 → 解析 + 加 `.js` |
| `./lib/errors` | `./lib/errors.ts` | `./lib/errors.js` | 无后缀 → 解析 + 加 `.js` |
| `./lib` | `./lib/index.ts` | `./lib/index.js` | 目录 → 解析 index |
| `./base.ts` | `./base.ts` | `./base.js` | 源后缀 → 产物后缀 |
| `./base.js` | `./base.js` 存在 | `./base.js`（不变） | 已是产物后缀，不处理 |
| `./base.js` | 仅 `./base.ts` 存在 | `./base.js`（不变） | Node16 风格说明符，产物必有 `base.js` |
| `./base.mjs` | — | `./base.mjs`（不变） | 已是产物后缀，不处理 |
| `../utils/helper` | `../utils/helper.ts` | `../utils/helper.js` | 父目录同理 |

## 无法解析的相对导入 → 构建期报错

相对 specifier（`./`、`../`）在项目内解析不到任何源文件时，`onLoad` 返回 esbuild error（带 file:line:column 与源码行文本），`esbuild.build` 直接失败：

- `faapi build` 构建失败，错误信息包含说明符文本与定位（如 ``无法解析的相对导入 "../../dao/call-logs"``）
- `faapi dev` 启动时 config/项目模块编译失败即启动失败；handler 的按需编译失败走既有"路由模块编译失败"请求错误通道
- 本地 TS 插件编译失败在插件加载阶段报错

理由：`bundle: false` 下 esbuild 不分析依赖图，静默保留会把源码级笔误推迟到生产运行时（Node ESM 严格解析报 `ERR_MODULE_NOT_FOUND`）才暴露——与 schema/agent config 提取"声明了却提取不出就报错"同一 fail-explicit 哲学。

**别名 specifier 解析失败不报错**——tsconfig paths 只是候选提示，未命中时裸说明符可能仍由 node_modules 运行时解析，误报会杀掉合法的包导入。

## API

| 函数 | 说明 |
|------|------|
| `toProdExtension(filePath)` | 源文件后缀转产物后缀：`.ts`/`.tsx`/`.jsx` → `.js`，其余原样（实现位于 [utils/prodPaths.ts](../utils/prodPaths.md)，本模块兼容 re-export） |
| `createAliasPlugin(config)` | 构造 esbuild `Plugin`，重写相对 specifier + 别名 specifier，不可解析相对导入报错 |
| `buildAliasPlugins(rootDir)` | 读 tsconfig 并构造插件数组（始终返回含本插件，相对路径重写不依赖 tsconfig） |
| `resolveRelativeSpecifier(importer, specifier)` | 解析相对 specifier 到实际源文件绝对路径（含 `.js` 说明符 → `.ts` 源回退），未解析到返回 `null`（[collectImports.ts](./collectImports.md) 复用其探测逻辑） |

## 相关模块

- `compileDevRoutes.ts` - dev 编译时调 `buildAliasPlugins` 挂载 specifier 重写
- `compileBuildRoutes.ts` - build 编译时调 `buildAliasPlugins` 挂载 specifier 重写
- `compileConfig.ts` - config 编译时调 `buildAliasPlugins` 挂载 specifier 重写
- `collectImports.ts` - 收集 config/按需编译的依赖闭包，复用 `resolveRelativeSpecifier` 探测逻辑
- `resolveAlias.ts`（utils）- 按 tsconfig paths 解析别名 specifier 为候选路径
- `readTsconfig.ts`（utils）- 读取并解析 tsconfig 的 paths 配置
