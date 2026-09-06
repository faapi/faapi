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

1. 遍历 declarations，解析为统一格式 { specifier, options, enable }（非法声明进 `failures`，不崩启动）
2. `enable: false` 跳过（唯一运行时开关——插件不应引入环境变量做冗余控制，详见 [pluginTypes.md](../config/pluginTypes.md#开关约定)）
3. name 去重（已加载的跳过）
4. `importPluginModule(specifier, rootDir, dist)` 加载：
   - **包名**（非相对/绝对路径）：原样 import，Node 按包解析
   - **本地路径**（`./x`、`../x`、绝对路径）：
     a. 探测源文件——原样（已带扩展名）→ `.ts`/`.js` → `/index.ts`/`/index.js`（Node ESM 对 file URL 不补全扩展名，无扩展名声明由框架探测）
     b. 产物存在且不比源码旧 → import 产物（build 固化 / dev 已编译产物复用）
     c. `.ts` 源码 + dev 按需模式（`isDevOnDemandEnabled()`）→ 编译后 import 产物：
        src 内插件走 `ensureCompiled`（打平产物与 routes 同一运行时对象）；src 外插件走
        `compileProjectModules`（入口 + src 外依赖 outbase=rootDir 保留结构，src 内依赖
        打平编译；aliasPlugin 重写 specifier——插件内部 `import '../src/xxx'` 无扩展名由此生效，
        剥离前缀的 import 路径相对插件产物位置计算，子目录产物正确回退 `../`）
     d. `.ts` 源码 + 非按需模式（prod / 编程式）且产物 stale → 报错指引 `faapi build`，
        不静默使用旧产物（与 handler 的 prod 语义一致）
     e. `.js` 源码：Node 可直接加载，import 源文件
     f. 找不到任何文件 → 报错带候选文件清单与修复指引（此前仅 `Cannot find module`，无法定位原因）
5. 取 mod.default ?? mod 作为插件对象
6. 注入 wrapHandler / wrapUpgradeHandler 收集器到 ctx
7. 调用 plugin.setup(ctx)
8. 返回收集到的 handlerWrappers / upgradeWrappers + `failures` 清单

**build 端配合**（[buildCommand](./buildCommand.md) 步骤 2.5）：build 时读 config.plugins 的本地路径
声明，`compileProjectModules` 编译到 `<dist>/plugins/`（保留相对结构），prod 运行时直接加载产物。

## 错误口径（单一语义）

任何插件级失败（import 失败、缺 setup、setup 抛错、非法声明）不中断其他插件、
不崩启动，但会收集进返回值 `failures` 并在加载完成后统一 `console.error` 汇总——
鉴权/CORS 类插件静默丢失等同裸奔，必须对业务方可见（此前仅单条 `console.warn`，
易被淹没）。调用方可依据 `failures` 做更严格的启动门禁。

## 包装器应用

loadPlugins 返回 `{ handlerWrappers, upgradeWrappers }`，由 `applyPluginWrappers(server, handlerWrappers, upgradeWrappers)` 在 listen 之前应用：

- 替换 server 的 request listener：`finalHandler = wrap1(wrap2(originalHandler))`
- 替换 server 的 upgrade listener：`finalUpgrade = wrap1(wrap2(originalUpgrade))`

## 相关模块

- [pluginTypes.ts](../config/pluginTypes.md) - FaapiPlugin / PluginContext / PluginDeclaration 类型
- [createApp.ts](./createApp.md) - 调用方（listen 之前调用）
- [startServer.ts](../server/startServer.md) - `applyPluginWrappers` 工具函数
