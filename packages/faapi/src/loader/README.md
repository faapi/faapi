# 路由模块加载与校验

从 handler.ts 动态导入模块，提取指定 HTTP 方法的 handler 函数。

## 模块

| 模块 | 说明 |
| --- | --- |
| [loadRouteModule.ts](./loadRouteModule.ts) | 动态 import 路由文件，提取 handler |
| [validateRouteModule.ts](./validateRouteModule.ts) | 校验导出值是否为合法的 handler 函数 |
| [resolveExports.ts](./resolveExports.ts) | 从模块对象中解析指定名称的导出 |

## 加载流程

```
filePath（绝对路径）
  → pathToFileURL（转为 file URL）
  → import(url)（动态导入）
  → resolveExport(module, method)（提取指定方法名的导出）
  → validateRouteModule（校验是否为函数）
  → RouteModule { handler, method }
```

## 相关模块

- [router](../router/README.md)：路由扫描，提供 filePath 和 method
- [server](../server/README.md)：调用 loadRouteModule
