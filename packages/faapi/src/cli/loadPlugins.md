# loadPlugins

一句话概括：遍历 config.plugins 声明，动态加载插件包并调用 setup(ctx)，收集 handler 包装器供框架在 listen 之前应用。

## 为什么需要

替代 `createApp` 中硬编码的 `try { import('@faapi/schema') }`，让插件加载声明式、可扩展。用户在 faapi.config.ts 的 plugins 字段声明插件，框架统一加载，主包零硬编码。

插件可通过 `ctx.wrapHandler` / `ctx.wrapUpgradeHandler` 在 server.listen 之前包装请求处理逻辑，用于集成其他框架（如 Next.js）。

## 使用场景

`createApp` 在 server 创建后、listen 之前调用 loadPlugins，收集包装器后由 `applyPluginWrappers` 应用到 server。

## 插件声明格式

```ts
plugins: [
  '@faapi/schema',                          // 包名
  ['@faapi/schema', { stdio: true }],        // 带选项
  { package: '@faapi/schema', enable: true }, // 完整声明
  { path: './my-plugin' },                    // 本地路径
]
```

## 加载流程

1. 遍历 declarations，解析为统一格式 { specifier, options, enable }
2. `enable: false` 跳过（唯一运行时开关——插件不应引入环境变量做冗余控制，详见 [pluginTypes.md](../config/pluginTypes.md#开关约定)）
3. name 去重（已加载的跳过）
4. await import(specifier) 加载
5. 取 mod.default ?? mod 作为插件对象
6. 注入 wrapHandler / wrapUpgradeHandler 收集器到 ctx
7. 调用 plugin.setup(ctx)
8. 返回收集到的 handlerWrappers / upgradeWrappers

## 包装器应用

loadPlugins 返回 `{ handlerWrappers, upgradeWrappers }`，由 `applyPluginWrappers(server, handlerWrappers, upgradeWrappers)` 在 listen 之前应用：

- 替换 server 的 request listener：`finalHandler = wrap1(wrap2(originalHandler))`
- 替换 server 的 upgrade listener：`finalUpgrade = wrap1(wrap2(originalUpgrade))`

## 相关模块

- [pluginTypes.ts](../config/pluginTypes.md) - FaapiPlugin / PluginContext / PluginDeclaration 类型
- [createApp.ts](./createApp.md) - 调用方（listen 之前调用）
- [startServer.ts](../server/startServer.md) - `applyPluginWrappers` 工具函数
