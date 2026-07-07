# scanRoutes

一句话概括：扫描文件系统，生成路由清单。支持 dev/build 模式（import 产物 `.js`）和旧模式（import 源码 `.ts`）。

## 为什么需要

faapi 的核心理念是"文件系统即路由"，需要将目录结构转换为路由清单。用户通过 CLI 指定 pattern，系统扫描匹配的文件，生成可用于路由匹配的数据结构。

## 使用场景

- CLI 启动时扫描 app 目录
- 根据 glob pattern 过滤路由文件
- 将文件路径转换为 URL 路径

## 文件类型与 dist 参数

`scanRoutes` 接受可选的 `dist` 参数（`.faapi/build` 或 `.faapi/dev`）：

- **传入 dist（dev/build 模式）**：扫描源码 `.ts` 文件列表，但 import 产物 `.js` 拿方法名。`filePath` 保持源码路径（如 `src/api/hello/handler.ts`），AST schema 提取需要 `.ts`。
- **不传 dist（旧模式，CLI 不再使用）**：扫描并 import 源码 `.ts`（依赖 esbuild 即时转译，仅 e2e/测试保留）。

中间件文件查找逻辑：
- 传入 dist：查找产物 `middlewares.js`（已编译）
- 不传 dist：优先 `.ts`，回退 `.js`

### 产物路径打平 src 前缀

`toProdAbsPath` 将源码绝对路径转为产物绝对路径时，会剥离 `src/` 前缀，与 `compileDevRoutes` / `compileBuildRoutes` 的 `outbase` 设置一致：

- 源码：`<rootDir>/src/api/hello/handler.ts`
- 产物：`<rootDir>/.faapi/build/api/hello/handler.js`（去掉 `src/` 前缀）

## 相关模块

- `parseRouteFile.ts` - 解析文件路径
- `sortRoutes.ts` - 排序扫描结果
- `routeTypes.ts` - 返回类型定义
- `compileDevRoutes.ts` / `compileBuildRoutes.ts` - 编译源码到产物（dev/build 模式前置步骤）
- `importWithCacheBust.ts` - ESM cache bust 加载
