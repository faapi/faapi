# scanRoutes

一句话概括：扫描文件系统，生成路由清单。

## 为什么需要

faapi 的核心理念是"文件系统即路由"，需要将目录结构转换为路由清单。用户通过 CLI 指定 pattern，系统扫描匹配的文件，生成可用于路由匹配的数据结构。

## 使用场景

- CLI 启动时扫描 app 目录
- 根据 glob pattern 过滤路由文件
- 将文件路径转换为 URL 路径

## 相关模块

- `parseRouteFile.ts` - 解析文件路径
- `sortRoutes.ts` - 排序扫描结果
- `routeTypes.ts` - 返回类型定义
