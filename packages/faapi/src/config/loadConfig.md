# loadConfig

一句话概括：查找并加载 faapi 配置文件，支持多环境深度合并。

## 为什么需要

faapi 支持通过 `faapi.config.ts` 统一配置响应格式、错误处理、生命周期钩子、中间件等。不同环境（开发/测试/生产）通常需要不同配置。`loadConfig` 封装了配置文件查找、环境识别、深度合并的逻辑，让 CLI 和 server 启动时获得最终配置对象。

## 使用场景

- `faapi` / `faapi dev` 启动时加载配置
- `faapi build` 构建时读取配置
- `--config` 参数指定配置文件路径
- `faapi.config.production.ts` 覆盖生产环境配置

## API

| 方法 | 说明 |
|------|------|
| `loadConfig(rootDir, configPath?)` | 加载并合并配置文件，返回 `Partial<FaapiConfig> \| null` |

### 查找顺序

1. 指定 `configPath` 时：直接加载该文件（不存在则抛错）
2. 未指定时：依次查找 `faapi.config.ts`、`faapi.config.js`（基础配置）
3. 找到基础配置后：按当前环境查找 `faapi.config.{env}.ts`、`faapi.config.{env}.js`（环境覆盖）

### 环境识别

优先级：`NODE_ENV` → `FAAPI_ENV` → `'development'`

### 深度合并规则

环境配置与基础配置深度合并，环境配置优先：

- 普通对象递归合并
- `Date` / `RegExp` / `Map` / `Set` / 数组 / 函数：直接替换，不递归合并

## 相关模块

- [config/configTypes.ts](./configTypes.ts) - `FaapiConfig` 类型定义
