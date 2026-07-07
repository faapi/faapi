# 配置模块

定义 faapi 框架的配置接口、配置加载与合并逻辑。

## 模块

| 模块 | 说明 |
| --- | --- |
| [configTypes.ts](./configTypes.ts) | FaapiConfig 接口及生命周期/插件类型 |
| [loadConfig.ts](./loadConfig.ts) | 从产物 `faapi-config.js` 读取配置 |
| [deepMerge.ts](./deepMerge.ts) | 深度合并工具（编译期内联到 compileConfig） |
| [pluginTypes.ts](./pluginTypes.ts) | FaapiPlugin / PluginContext / PluginDeclaration |

## FaapiConfig 字段

应用行为配置（CORS、lifecycle、middlewares、业务配置等）从 `faapi.config.ts` 读取；框架元信息（port/dist）通过环境变量传入,不放在 config 内。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `cors` | `CorsOptions` | CORS 配置 |
| `helmet` | `HelmetOptions` | 安全头配置 |
| `bodyLimit` | `number` | 请求体大小上限 |
| `logger` | `LoggerOptions \| boolean` | 请求日志配置,默认启用 |
| `http2` | `boolean` | 是否启用 HTTP/2 |
| `lifecycle` | `LifecycleHooks` | 生命周期钩子（onReady/onClose/onError） |
| `middlewares` | `FaapiMiddleware[]` | 全局中间件（最外层） |
| `injectors` | `InjectorMap` | 全局注入器映射表 |
| `plugins` | `PluginDeclaration[]` | 插件声明数组 |
| `extendContext` | `(ctx) => void` | 扩展 ctx 方法/属性 |

> 框架元信息通过环境变量传入：`PORT`（端口,默认 3000）、`FAAPI_DIST`（产物目录,dev 固定 `.faapi`,prod 默认 `dist`（可通过 `--dist` 修改））。

业务自定义 key（如 `db`/`redis`）通过 `ctx.config` 访问,详见 [configTypes.md](./configTypes.md)。
