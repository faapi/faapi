# parseRouteFile

一句话概括：解析路由文件路径，转换为 URL 路径。

## 为什么需要

文件系统路径和 URL 路径格式不同：
- 文件路径：`api/user/[id]/handler.ts`
- URL 路径：`/api/user/:id`

需要转换函数处理这种映射，同时识别动态路由片段。

说明：API 路由放在 `api/` 下，剥离 `app/` 后 URL 自然带 `/api` 前缀。

## 使用场景

- 路由扫描时转换文件路径
- 提取动态参数名

## 相关模块

- `scanRoutes.ts` - 调用此模块转换路径
- `constants.ts` - 使用 HTTP 方法定义
- `normalizePath.ts` - 标准化路径
