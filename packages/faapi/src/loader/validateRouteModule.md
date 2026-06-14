# validateRouteModule

一句话概括：校验路由模块导出是否为合法 handler。

## 为什么需要

路由模块必须导出函数类型的 handler，需要校验并提供清晰的错误信息。

## 使用场景

- 模块加载后校验
- 提供友好的开发错误提示

## 相关模块

- `loadRouteModule.ts` - 调用此函数
