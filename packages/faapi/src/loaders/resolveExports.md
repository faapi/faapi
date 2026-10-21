# resolveExports

一句话概括：从模块中提取指定导出。

## 为什么需要

动态 import 的模块需要提取对应方法的 handler（如 `GET`、`POST`）。

## 使用场景

- 提取 handler 函数
- 统一导出访问接口

## 相关模块

- `loadRouteModule.ts` - 调用此函数
