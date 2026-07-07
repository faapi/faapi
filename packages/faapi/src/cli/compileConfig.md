# compileConfig

一句话概括：编译并合并配置文件（基础 + 环境覆盖），输出 `faapi-config.js` 供运行时 `loadConfig` 直接 import，且 config 与 routes 共享同一份项目模块（`instanceof` 跨边界生效）。

## 为什么需要

`loadConfig` 运行时只负责 import `faapi-config.js` 产物，不做编译、不做 env 合并。`compileConfig` 负责把源码 `faapi.config.ts` + `faapi.config.{env}.ts` 一次性合并为 `faapi-config.js`：

- 运行时 `loadConfig` 直接 import 产物，零编译、零合并
- env 在编译阶段固化（由 `NODE_ENV`/`FAAPI_ENV` 决定）
- 第三方依赖保持 external，运行时从用户 `node_modules` 解析
- **config 引用的项目模块（如自定义错误类）与 routes 引用的同一模块在运行时是同一对象**，`instanceof` 跨 config/routes 生效

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

## 工作机制（两步编译）

### 步骤 1：逐文件编译 config 源文件（`bundle: false`）

用 `bundle: false` + `buildAliasPlugins(rootDir)` 编译 `faapi.config.ts` 和 `faapi.config.{env}.ts` 到 outDir：

- 配置源文件的相对/别名 import 由 `aliasPlugin` 重写为产物路径（带 `.js` 后缀）
- 产物 `faapi.config.js` 中的相对 import 指向 outDir 内的已编译模块
- **不 inline**：config 引用的项目模块（如 `./lib/errors`）被编译为独立产物 `lib/errors.js`，运行时按需 import

产物示例：

```
outDir/
├── faapi.config.js          # faapi.config.ts 编译产物（import './lib/errors.js'）
├── faapi.config.production.js  # faapi.config.production.ts 编译产物
└── lib/errors.js            # 项目模块编译产物（与 routes 共享）
```

### 步骤 2：编译合并入口（`bundle: true` + external 相对路径）

生成虚拟入口源码（esbuild `stdin`），import 已编译的 config 产物 + 内联 `deepMerge` 函数 + `export default` 合并结果：

```js
import base from './faapi.config.js';
import env from './faapi.config.production.js';
const deepMerge = function deepMerge(base, override) { /* ... */ };
export default deepMerge(base, env);
```

用 `bundle: true` 编译，**相对路径 import 标记为 external**（通过 onResolve 插件），不 inline 已编译的 config 产物。第三方依赖（`packages: 'external'`）也保持 external。

产物 `outDir/faapi-config.js` 保留 `import base from './faapi.config.js'` 语句，运行时 Node.js ESM loader 加载 `faapi.config.js`，后者再 import `./lib/errors.js`——与 routes 编译的 `./lib/errors.js` 是同一文件，`instanceof` 生效。

## instanceof 共享原理

问题：旧方案用 `bundle: true` 编译 config，把配置源文件的相对 import（如 `./lib/errors`）inline 进 `faapi-config.js`。当 routes 也 import 同一模块时，该模块被分别打包成两个不同的运行时对象，`instanceof` 失效。

修复：两步编译使 config 产物**引用**（而非 inline）项目模块产物。config 和 routes 都 import 同一份 `lib/errors.js`，Node.js ESM 模块缓存确保只加载一次，`instanceof` 正常工作。

```
                    faapi-config.js
                         │ import
                         ▼
                    faapi.config.js
                         │ import
                         ▼
                    lib/errors.js  ◄─── import ─── api/test/handler.js
                    (单一运行时对象，instanceof 生效)
```

## deepMerge 复用

`deepMerge` 函数定义在 `src/config/deepMerge.ts`，同时导出：

- `deepMerge` 函数：编程式合并使用
- `DEEP_MERGE_SOURCE` 字符串常量：通过 `deepMerge.toString()` 序列化函数源码，`compileConfig` 内联到入口源码

`compileConfig` 通过 `DEEP_MERGE_SOURCE` 内联 `deepMerge` 函数源码到入口源码（步骤 2），保证编译时合并与函数定义完全一致，入口产物自包含 deepMerge 逻辑。

## 边界情况

- **无基础配置文件**：不生成产物，`loadConfig` 返回 `null`（配置可选）
- **仅基础配置无 env 配置**：入口源码直接 `export default base`，不调用 `deepMerge`
- **配置文件中的 `process.env.*` 表达式**：保留（不传 `define`），运行时读取环境变量
  - 例：`dbPassword: process.env.DB_PASSWORD` 保留为运行时表达式
- **函数型配置**（`extendContext`/`middlewares`/`lifecycle` 等）：esbuild 编译保留为可执行函数，运行时正常调用
- **配置文件引用项目模块**（如 `import { AppError } from './lib/errors'`）：步骤 1 编译 config 源 + 项目模块到 outDir，步骤 2 入口 external 引用 config 产物，运行时与 routes 共享同一模块实例

## 相关模块

- [config/deepMerge.ts](../config/deepMerge.ts) - `deepMerge` 函数与 `DEEP_MERGE_SOURCE` 字符串常量
- [config/loadConfig.ts](../config/loadConfig.ts) - 运行时配置加载（统一读 `faapi-config.js` 产物）
- [cli/buildCommand.ts](./buildCommand.ts) - 构建命令，调用 `compileConfig` 生成 `dist/faapi-config.js`
- [cli/devCommand.ts](./devCommand.ts) - dev 命令，启动时调 `compileConfig` 生成 `.faapi/dev/faapi-config.js`
- [cli/watcher.ts](./watcher.ts) - watcher 文件变化时调 `compileConfig` 重生成产物
- [cli/aliasPlugin.ts](./aliasPlugin.ts) - specifier 重写插件（相对 + 别名），步骤 1 编译时挂载
- [cli/compileDevRoutes.ts](./compileDevRoutes.ts) - 路由逐文件编译（与 config 编译一致）
