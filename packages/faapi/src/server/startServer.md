# applyPluginWrappers（startServer.ts）

一句话概括：把插件的 handler / upgrade 包装器嵌套应用到 HTTP server 的 request / upgrade listener 上（server.listen 之前调用）。

## 为什么需要

插件（如 @faapi/schema）需要在请求链路上挂自己的端点。包装器模型让插件无需知道框架内部编排——拿到原始 handler，包一层（透传或短路），框架把包装后的 handler 挂回 server。包装按数组顺序嵌套：`finalHandler = wrap1(wrap2(originalHandler))`。

## 使用场景

- `createAppCore.ts` 启动编排中，`loadPlugins` 收集插件包装器后调用
- `@faapi/next` 的 e2e 测试直接复用

## 行为约定

- 只替换 server 上**第一个** request / upgrade listener（框架自身只挂一个）
- upgrade 包装器收到原始 upgrade handler（无 WS 路由时框架同样挂载了 404 兜底，通常有值），返回 `undefined` 表示移除 upgrade 处理
- 本文件只承载 `applyPluginWrappers` 等 listen 相关工具函数；应用启动编排统一在 `createAppCore`

## 相关模块

- `../configs/pluginTypes.ts` - RequestHandler / UpgradeHandler 类型
- `../cli/createAppCore.ts` - 唯一生产消费方
- `../cli/loadPlugins.ts` - 收集插件包装器
