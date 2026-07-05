# compileConfig

一句话概括：编译并合并配置文件（基础 + 环境覆盖），输出单个 `faapi-config.js` 供运行时 `loadConfig` 直接 import。

## 为什么需要

`loadConfig` 运行时只负责 import `faapi-config.js` 产物，不做编译、不做 env 合并。`compileConfig` 负责把源码 `faapi.config.ts` + `faapi.config.{env}.ts` 一次性合并为自包含的 `faapi-config.js`：

- 运行时 `loadConfig` 直接 import 产物，零编译、零合并
- env 在编译阶段固化（由 `NODE_ENV`/`FAAPI_ENV` 决定）
- 第三方依赖保持 external，运行时从用户 `node_modules` 解析

dev 和 prod 都调用 `compileConfig`，只是 outDir 不同：

| 模式 | 调用时机 | outDir | 产物 |
|------|---------|--------|------|
| dev | `devCommand` 启动时 + watcher 文件变化时 | `.faapi/dev` | `.faapi/dev/faapi-config.js` |
| prod | `buildCommand` 构建时 | `dist` | `dist/faapi-config.js` |

## 使用场景

- `faapi dev` 启动时：`devCommand` 调 `compileConfig({ rootDir, outDir: '.faapi/dev' })`
- `faapi dev` watcher 文件变化时：`watcher` 调 `compileConfig`（如 `faapi.config.ts` 变化）
- `faapi build` 构建时：`buildCommand` 调 `compileConfig({ rootDir, outDir: 'dist' })`

产物由 `loadConfig(rootDir, outDir)` 在运行时统一 import。

## 工作机制

1. **查找基础配置**：`faapi.config.ts` → `faapi.config.js`（与 `loadConfig` 同序）
2. **查找环境配置**：按 `FAAPI_ENV`/`NODE_ENV`/`'development'` 查找 `faapi.config.{env}.ts` → `.js`
3. **生成虚拟入口源码**：esbuild `stdin` 传入，import 两个配置 + 内联 `deepMerge` 函数 + `export default deepMerge(base, env)`
4. **esbuild bundle 编译**：`bundle: true` + `packages: 'external'`，配置文件的相对 import 被打包进产物，第三方依赖保留 external

入口源码示意：

```js
import base from './faapi.config';
import env from './faapi.config.production';
const deepMerge = function deepMerge(base, override) { /* ... */ };
export default deepMerge(base, env);
```

## deepMerge 复用

`deepMerge` 函数定义在 `src/config/deepMerge.ts`，同时导出：

- `deepMerge` 函数：编程式合并使用
- `DEEP_MERGE_SOURCE` 字符串常量：通过 `deepMerge.toString()` 序列化函数源码，`compileConfig` 内联到入口源码

`compileConfig` 通过 `DEEP_MERGE_SOURCE` 内联 `deepMerge` 函数源码到产物，保证编译时合并与函数定义完全一致，产物自包含、不依赖 `@faapi/faapi` 内部模块。

## 边界情况

- **无基础配置文件**：不生成产物，`loadConfig` 返回 `null`（配置可选）
- **仅基础配置无 env 配置**：直接导出基础配置，不调用 `deepMerge`
- **配置文件中的 `process.env.*` 表达式**：保留（不传 `define`），运行时读取环境变量
  - 例：`dbPassword: process.env.DB_PASSWORD` 保留为运行时表达式
- **函数型配置**（`extendContext`/`middlewares`/`lifecycle` 等）：esbuild bundle 保留为可执行函数，运行时正常调用

## 相关模块

- [config/deepMerge.ts](../config/deepMerge.ts) - `deepMerge` 函数与 `DEEP_MERGE_SOURCE` 字符串常量
- [config/loadConfig.ts](../config/loadConfig.ts) - 运行时配置加载（统一读 `faapi-config.js` 产物）
- [cli/buildCommand.ts](./buildCommand.ts) - 构建命令，调用 `compileConfig` 生成 `dist/faapi-config.js`
- [cli/devCommand.ts](./devCommand.ts) - dev 命令，启动时调 `compileConfig` 生成 `.faapi/dev/faapi-config.js`
- [cli/watcher.ts](./watcher.ts) - watcher 文件变化时调 `compileConfig` 重生成产物
- [cli/compileRoutes.ts](./compileRoutes.ts) - TypeScript 编译（路由文件，与配置编译分离）
