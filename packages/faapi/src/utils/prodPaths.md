# prodPaths

一句话概括：源码路径 → 产物路径的公共转换函数与目录常量——`toProdFilePath`（去 src/ 前缀 + dist 前缀 + .ts→.js）、`toProdExtension`、`toRealPath` / `isInsideDir`（符号链接安全的目录判断）。

## 为什么需要

产物路径转换逻辑被多个构建管线共用（generateRoutes / scanRoutes / generateToolArtifacts / generateAgentArtifacts 的 `toProdFilePath`、compileConfig / aliasPlugin 的 `toRealPath` / `isInsideDir` / `toProdExtension`）。路径规则必须全管线一致——收敛为单一实现后，规则调整（如打平前缀变化）只改一处，不会出现 dev/prod 产物路径不一致的隐性 bug。

## 使用场景

- 路由/tool/agent 清单生成：源码相对路径 → 产物相对路径（`toProdFilePath`）
- esbuild 插件重写 import specifier 的后缀（`toProdExtension`）
- config 依赖图收集与 alias 重写中判断文件是否在 src 内（`toRealPath` + `isInsideDir`，macOS /tmp 符号链接场景）
- `APP_DIR`（源码目录固定为 `src`）与 `ROUTE_PATTERNS`（`src/api/**/*.ts`）常量的单一来源

## 行为定义

- `toProdFilePath(filePath, dist)`：`\` → `/`；strip `src/` 前缀；`.ts` → `.js`；已带 `<dist>/` 前缀则保持，否则补上
- `toProdExtension(filePath)`：`.ts` → `.js`（-3）、`.tsx`/`.jsx` → `.js`（-4）、其余原样
- `toRealPath(p)`：`fs.realpathSync` 规范化；不存在时回退原路径（不抛错）
- `isInsideDir(filePath, dir)`：基于 `path.relative`——不以 `..` 开头且非绝对且非空即视为在内；调用前应先用 `toRealPath` 规范化两侧

## 相关模块

- `../routers/scanRoutes.ts` / `../cli/generateRoutes.ts` / `../cli/generateToolArtifacts.ts` / `../cli/generateAgentArtifacts.ts` - `toProdFilePath` 消费方
- `../cli/compileConfig.ts` / `../cli/aliasPlugin.ts` - `toRealPath` / `isInsideDir` / `toProdExtension` 消费方
