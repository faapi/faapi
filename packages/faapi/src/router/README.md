# 路由系统

路由系统，实现文件系统路由的扫描、匹配、排序和冲突检测，将目录结构映射为 API 路由和页面路由。

## 模块

| 模块 | 说明 |
| --- | --- |
| [scanRoutes.ts](./scanRoutes.ts) | 扫描 app 目录，生成路由清单 |
| [matchRoute.ts](./matchRoute.ts) | 根据 method + path 匹配路由 |
| [sortRoutes.ts](./sortRoutes.ts) | 路由排序（静态路由优先于动态路由） |
| [detectRouteConflicts.ts](./detectRouteConflicts.ts) | 冲突检测 |
| [parseRouteFile.ts](./parseRouteFile.ts) | 文件路径解析：路径→URL、提取参数名 |
| [routeTypes.ts](./routeTypes.ts) | 类型定义：RouteRecord、RouteManifest、RouteMatch |
| [constants.ts](./constants.ts) | HTTP 方法常量 |

## 路由格式

路由文件使用 `handler.ts` 命名，导出 HTTP 方法名作为 handler：

```ts
// api/user/handler.ts
export function GET() { return { list: [] } }
export function POST(body: any) { return { created: true } }
```

## 动态路由

使用 `[name]` 目录映射为 `:name` 参数：

```
api/user/[id]/handler.ts  →  GET /api/user/:id
```

## 扫描流程

```
glob patterns
  → 过滤 handler.ts 文件
  → extractMethodsFromHandler（动态导入提取 HTTP 方法导出）
  → filePathToUrlPath（路径转 URL）
  → extractParamNames（提取动态参数名）
  → findNearestMiddlewares（向上查找中间件）
  → RouteManifest
```

## 相关模块

- [middleware](../middleware/README.md)：中间件加载
- [loader](../loader/README.md)：路由模块加载
