# prodPaths

一句话概括：源码路径 → 产物路径的公共转换函数与目录常量——`toProdFilePath`（去 src/ 前缀 + dist 前缀 + .ts→.js）、`toProdExtension`、`toRealPath` / `isInsideDir`（符号链接安全的目录判断）。

## 为什么需要

产物路径转换逻辑此前有 4 份逐字相同的 `toProdFilePath` 实现（generateRoutes / scanRoutes / generateToolArtifacts / generateAgentArtifacts）、2 份 `toRealPath` / `isInsideDir` / `toProdExtension`（compileConfig / aliasPlugin）。多份拷贝在路径规则调整（如打平前缀变化）时必须同步改多处，漏改即产生 dev/prod 产物路径不一致的隐性 bug。

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

- `../router/scanRoutes.ts` / `../cli/generateRoutes.ts` / `../cli/generateToolArtifacts.ts` / `../cli/generateAgentArtifacts.ts` - `toProdFilePath` 消费方（原 4 份实现合并至此）
- `../cli/compileConfig.ts` / `../cli/aliasPlugin.ts` - `toRealPath` / `isInsideDir` / `toProdExtension` 消费方（原 2 份实现合并至此）
