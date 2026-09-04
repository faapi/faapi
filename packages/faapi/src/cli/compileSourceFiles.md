# compileSourceFiles

一句话概括：dev/prod 共用的逐文件 TypeScript 编译实现——每个 `.ts` 独立编译为 `.js`（`bundle: false`），产物打平 src/ 前缀；`compileDevRoutes` / `compileBuildRoutes` 是它的两个模式薄封装。

## 为什么需要

`compileDevRoutes` 与 `compileBuildRoutes` 此前约 90% 代码逐字重复（文件收集、目录创建、alias 插件、esbuild 选项），差异仅三点：build 多 `define` + `minifySyntax`、dev 多原子写、glob ignore 列表逐字重复。重复导致编译行为调整必须双处同步，漏改即 dev/prod 产物不一致。

## 使用场景

- 不直接使用——通过 `compileDevRoutes`（dev：原子写）或 `compileBuildRoutes`（prod：NODE_ENV 编译期替换 + 死分支删除）调用
- 两者的行为定义见各自测试：`compileDevRoutes.test.ts`（原子写、增量、打平）、`compileBuildRoutes.test.ts`（NODE_ENV 替换、无 chunk、增量）

## 选项矩阵

| 选项 | dev 封装 | build 封装 |
|------|---------|-----------|
| `atomicWrite` | `true`（tmp + rename，运行时不会读到半成品产物） | `false`（esbuild 直接写） |
| `production` | `false`（不传 define，`process.env.NODE_ENV` 运行时读取） | `true`（编译期替换为 `"production"` + `minifySyntax` 删死分支） |

其余语义（打平 src 前缀、`bundle: false` 保证 `instanceof` 跨 config/routes 边界生效、别名编译期重写、排除 `*.test.ts`/`*.d.ts`）两种模式完全一致，见 AGENTS.md §5.3。

## 相关模块

- `compileDevRoutes.ts` / `compileBuildRoutes.ts` - 两个模式薄封装（保持既有导出签名，调用方无感）
- `aliasPlugin.ts` - 别名重写插件（编译期挂载）
- `../utils/prodPaths.ts` - `APP_DIR` 常量（outbase 计算）
