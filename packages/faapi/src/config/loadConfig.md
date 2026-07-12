# loadConfig

一句话概括：加载 faapi 配置产物，统一读 `<dist>/faapi-config.js`，dev/prod 同路径无分支。

## 为什么需要

faapi 通过 `faapi.config.ts` 统一配置响应格式、错误处理、生命周期钩子、中间件等。配置源码由 `compileConfig`（dev 启动时 / build 时）预编译为单个 `faapi-config.js` 产物，运行时 `loadConfig` 只负责 import 该产物，不做编译。

这种「产物驱动」设计让 dev 和 prod 走完全一致的代码路径：差异仅是 `dist` 参数（dev = `.faapi`，prod = `dist`），不存在 `if (isDev)` 分支。

环境变量通过 `.env` 系列文件加载（见 [loadEnv](../cli/loadEnv.md)），配置文件中通过 `process.env.XXX` 读取，运行时取值。

## 使用场景

- `faapi` / `faapi dev` 启动时：`devCommand` 先调 `compileConfig` 生成 `.faapi/faapi-config.js`，再调 `loadConfig(rootDir, '.faapi')`
- `faapi build` 时：`buildCommand` 调 `compileConfig` 生成 `dist/faapi-config.js`
- `node dist/main` 生产启动时：`createProdApp` 调 `loadConfig(rootDir, 'dist')` 读 build 产物
- 编程式调用：传 `dist` 指定产物所在目录

## API

| 方法 | 说明 |
|------|------|
| `loadConfig(rootDir, dist)` | 从 `<rootDir>/<dist>/faapi-config.js` 加载配置产物，返回 `Partial<FaapiConfig> \| null` |

参数：

| 参数 | 类型 | 说明 |
|------|------|------|
| `rootDir` | `string` | 项目根目录 |
| `dist` | `string` | 产物目录（dev 为 `.faapi`，prod 为 `dist`） |

## 行为

1. 检查 `<rootDir>/<dist>/faapi-config.js` 是否存在
2. **存在**：`importWithCacheBust` 导入并返回 `module.default`（无 default 返回 `{}`）
3. **不存在但源码有 `faapi.config.ts`/`faapi.config.js`**：抛错「请先执行 `faapi build`（或 `faapi dev`）生成产物」（无 fallback，强制生成产物）
4. **不存在且源码也无配置文件**：返回 `null`（配置可选）

环境变量由 `loadEnv` 从 `.env` 系列文件加载到 `process.env`，配置文件中通过 `process.env.XXX` 读取，运行时取值。

## 相关模块

- [cli/loadEnv.ts](../cli/loadEnv.ts) - `.env` 系列文件加载器（环境变量注入 `process.env`）
- [cli/compileConfig.ts](../cli/compileConfig.ts) - 编译配置文件为 `faapi-config.js`（dev 启动时和 build 时调用）
- [utils/importWithCacheBust.ts](../utils/importWithCacheBust.ts) - 动态 import 与 ESM 缓存绕过
