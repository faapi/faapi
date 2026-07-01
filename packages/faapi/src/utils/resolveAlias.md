# resolveAlias

一句话概括：按 tsconfig paths 配置把 import specifier 解析为候选绝对路径（纯函数，不检查文件存在性）。

## 为什么需要

dev 和 build 的 esbuild 别名重写插件都需要把 `@/lib/db` 这类别名转成实际文件路径。两处逻辑完全一致（都是按 paths pattern 做模式匹配），故抽取为纯函数共享。

纯函数设计（不做 IO、不检查文件存在性）的好处：
- 可独立单测，无需 fixture 文件
- 调用方各自负责文件存在性尝试（esbuild onLoad 插件试 `.ts`→相对路径）

支持两种 pattern：
- **精确匹配**（无 `*`）：specifier 必须与 pattern 完全相等
- **通配匹配**（单个 `*`）：按 `*` 分割 prefix/suffix，specifier 需前缀+后缀匹配，捕获中间部分替换到目标的 `*`

TypeScript paths 规范只允许单个 `*`，本函数不处理多 `*`。

## 使用场景

- `compileRoutes.ts` 的 esbuild onLoad 插件内调用，把别名 specifier 解析为候选路径后重写为产物相对路径写入产物
- dev 模式（`.faapi/dev/`）和 build 模式（`dist/`）共用同一编译逻辑

## 相关模块

- `readTsconfig.ts` - 提供 `TsconfigPathsConfig` 配置（baseUrl + paths 已规范化为绝对路径）
- `compileRoutes.ts` - 编译时调用方（esbuild 别名重写插件）
