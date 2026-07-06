# pluginTypes

一句话概括：定义 faapi 插件接口（FaapiPlugin）、插件上下文（PluginContext）和声明格式（PluginDeclaration）。

## 为什么需要

faapi 需要一个声明式的插件系统，让扩展包通过约定接口注册，而非在主包硬编码。类型定义确保插件作者和框架之间有明确的契约。

插件可通过 `wrapHandler` / `wrapUpgradeHandler` 在 server.listen 之前包装请求处理逻辑，用于集成其他框架（如 @faapi/next 把 `/api/*` 走 faapi，其余走 Next.js）。

## 核心类型

- **FaapiPlugin**：插件接口，包含 name（去重和日志）和 setup(ctx)（初始化函数）
- **PluginContext**：插件上下文，包含 rootDir、routes（setup 时快照）、getRoutes（返回最新路由）、server、config、options、wrapHandler、wrapUpgradeHandler
- **PluginDeclaration**：用户在 faapi.config.ts 中声明插件的方式（字符串/元组/对象）
- **RequestHandler / UpgradeHandler**：handler 类型，供包装器使用

## routes vs getRoutes

`ctx.routes` 是 setup 时的路由数组快照，`reloadRoutes` 后不会更新（`updateRoutes` 重新赋值局部变量，不影响旧引用）。需要最新路由的插件用 `ctx.getRoutes()`——它返回当前的路由数组，dev `reloadRoutes` 后自动反映变更。缓存路由数据的插件（如 @faapi/schema）应通过 `getRoutes()` 获取并做引用比较检测变更。

## 开关约定

插件的启用/禁用**完全由 `faapi.config.ts` 的 `plugins` 声明驱动**：

- 在 `plugins` 数组中声明即启用，移除即禁用
- `{ package: '@faapi/schema', enable: false }` 用于临时禁用（`enable` 仅在显式 `false` 时跳过）
- **插件内部不应使用环境变量做冗余的启用/禁用控制**——这会与声明机制重叠，导致用户困惑（"我声明了插件，为什么没生效？哦原来还有个环境变量"）

如果插件需要根据环境差异化行为（如 dev/prod 不同配置），应通过 `options` 传入或读取 `ctx.config` 中的业务配置，而非自行读取环境变量决定是否启动。

## wrapHandler / wrapUpgradeHandler

插件通过这两个方法注册包装函数，框架在 listen 之前按注册顺序嵌套应用：

```ts
// 插件 setup 中
ctx.wrapHandler((original) => (req, res) => {
  if (req.url?.startsWith('/api/')) {
    original(req, res);  // 走 faapi
  } else {
    otherHandler(req, res);  // 走其他框架
  }
});
```

多个包装器按注册顺序嵌套：`finalHandler = wrap1(wrap2(originalHandler))`。

## 加载时机

插件在 server 创建后、listen 之前（beforeListen 钩子中）加载。这确保插件能包装 handler，且包装后的 handler 在 server 开始处理请求前生效。

## 相关模块

- [configTypes.ts](./configTypes.md) - FaapiConfig.plugins 字段引用 PluginDeclaration
- [loadPlugins.ts](../cli/loadPlugins.md) - 加载和执行插件，收集包装器
- [startServer.ts](../server/startServer.md) - applyPluginWrappers 工具函数
