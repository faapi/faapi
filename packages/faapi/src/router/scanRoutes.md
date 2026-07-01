# scanRoutes

一句话概括：扫描文件系统，生成路由清单。支持 dev/build 模式（import 产物 `.js`）和旧模式（import 源码 `.ts`）。

## 为什么需要

faapi 的核心理念是"文件系统即路由"，需要将目录结构转换为路由清单。用户通过 CLI 指定 pattern，系统扫描匹配的文件，生成可用于路由匹配的数据结构。

## 使用场景

- CLI 启动时扫描 app 目录
- 根据 glob pattern 过滤路由文件
- 将文件路径转换为 URL 路径

## 文件类型与 prodDir 参数

`scanRoutes` 接受可选的 `prodDir` 参数（`dist` 或 `.faapi/dev`）：

- **传入 prodDir（dev/build 模式）**：扫描源码 `.ts` 文件列表，但 import 产物 `.js` 拿方法名。`filePath` 保持源码路径（如 `src/api/hello/handler.ts`），AST schema 提取需要 `.ts`。
- **不传 prodDir（旧模式，CLI 不再使用）**：扫描并 import 源码 `.ts`（依赖 tsx 即时转译，仅 e2e/测试保留）。

中间件文件查找逻辑：
- 传入 prodDir：查找产物 `middlewares.js`（已编译）
- 不传 prodDir：优先 `.ts`，回退 `.js`

## 相关模块

- `parseRouteFile.ts` - 解析文件路径
- `sortRoutes.ts` - 排序扫描结果
- `routeTypes.ts` - 返回类型定义
- `compileRoutes.ts` - 编译源码到产物（dev/build 模式前置步骤）
- `importWithCacheBust.ts` - ESM cache bust 加载
