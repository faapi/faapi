# loadConfig

一句话概括：加载 faapi 配置产物，统一读 `<dist>/faapi-config.js`，dev/prod 同路径无分支。

## 为什么需要

faapi 通过 `faapi.config.ts` 统一配置响应格式、错误处理、生命周期钩子、中间件等。配置源码由 `compileConfig`（dev 启动时 / build 时）预编译合并为单个 `faapi-config.js` 产物，运行时 `loadConfig` 只负责 import 该产物，不做编译、不做 env 合并。

这种「产物驱动」设计让 dev 和 prod 走完全一致的代码路径：差异仅是 `dist` 参数（dev = `.faapi`，prod = `dist`），不存在 `if (isDev)` 分支。

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

env 合并在 `compileConfig` 阶段完成（按 `FAAPI_ENV > NODE_ENV > 'development'` 选择 `faapi.config.{env}.ts` 与基础配置深度合并），运行时 `loadConfig` 拿到的已是合并后的最终配置，不再依赖运行时 `NODE_ENV`。

## 深度合并规则

环境配置与基础配置深度合并，环境配置优先（`deepMerge` 函数见 `deepMerge.ts`）：

- 普通对象递归合并
- `Date` / `RegExp` / `Map` / `Set` / 数组 / 函数：直接替换，不递归合并

`deepMerge` 函数源码同时通过 `DEEP_MERGE_SOURCE`（`deepMerge.toString()` 序列化）内联到 `compileConfig` 生成的 `faapi-config.js` 产物中，确保编译时合并与产物自包含。

## 相关模块

- [config/deepMerge.ts](./deepMerge.ts) - `deepMerge` 函数与 `DEEP_MERGE_SOURCE` 字符串常量
- [cli/compileConfig.ts](../cli/compileConfig.ts) - 编译合并配置文件为 `faapi-config.js`（dev 启动时和 build 时调用）
- [utils/importWithCacheBust.ts](../utils/importWithCacheBust.ts) - 动态 import 与 ESM 缓存绕过
