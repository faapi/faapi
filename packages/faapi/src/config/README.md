# 配置类型定义

定义 faapi 框架的配置接口。

## 模块

| 模块 | 说明 |
| --- | --- |
| [configTypes.ts](./configTypes.ts) | FaapiConfig 接口 |

## FaapiConfig

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `rootDir` | `string` | 项目根目录 |
| `appDir` | `string` | app 目录名 |
| `port` | `number` | 服务端口 |
| `patterns` | `string[]` | 路由 glob 模式 |
