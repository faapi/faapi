# createApp / createDevApp / createProdApp

一句话概括：faapi 的高层编程式启动 API，按 dev/prod 拆为两套入口（共享 `createAppBase` 编排核心），`createApp` 为 `createProdApp` 的向后兼容别名。

## 为什么需要

参考 NestJS 的 `NestFactory.create()` 模式，faapi 提供编程式启动 API。为分离 dev/prod 代码路径：

- **`createDevApp`**：dev 专用，含 `reloadRoutes` 热替换能力，由 `faapi dev` 内部调用
- **`createProdApp`**：prod 专用，精简（无 reloadRoutes），由 `dist/main.js` 内部调用
- **`createApp`**：`createProdApp` 的向后兼容别名，供编程式调用场景使用
- **`createAppBase`**（`createAppCore.ts`）：dev/prod 共享的编排核心（配置加载 → 路由水合 → 创建 server → 插件加载 → listen/close）

dev 和 prod 为两套独立代码，仅共享 `createAppBase` 和工具级函数，无 `if (isDev)` 分支。

## 零入口设计

框架采用零入口设计——用户无需编写 `main.ts`：

- dev：`faapi dev` 内部调 `createDevApp()` + `listen()`
- prod：`faapi build` 自动生成 `dist/main.js` 启动入口（内部 import `createProdApp` + `listen`），`node dist/main` 直接启动

`createApp` / `createProdApp` / `createDevApp` 主要供编程式调用场景使用（如自定义启动器、测试场景），`dist/main.js` 内部也调用它们完成启动。

用户自定义启动逻辑（初始化数据库、注册信号处理等）通过 `faapi.config.ts` 的 `lifecycle.onReady` / `onClose` 钩子实现，dev/prod 都执行。

## 统一产物驱动

`createAppBase` 不负责编译 TypeScript——编译由 `faapi dev`（`compileDevRoutes` 增量编译到 `.faapi/`）和 `faapi build`（`compileBuildRoutes` 逐文件编译（bundle: false）到 `dist/`）负责。`createAppBase` 只消费已编译的产物三元组：

| 产物 | dev 模式路径 | prod 模式路径 | 由谁生成 |
|------|------------|-------------|---------|
| 路由/middleware 编译 `.js` | `.faapi/**/*.js` | `dist/**/*.js` | `compileDevRoutes` / `compileBuildRoutes` |
| 配置产物 | `.faapi/faapi-config.js` | `dist/faapi-config.js` | `compileConfig` |
| 路由清单 | `.faapi/faapi-routes.js` | `dist/faapi-routes.js` | `generateRouteArtifacts` / `buildCommand` |
| schema 模块 | `.faapi/**/zod.js` | `dist/**/zod.js` | `generateSchemaFiles` |

`dist` 由 `process.env.FAAPI_DIST` 决定：

- `faapi dev` 启动时设为 `.faapi` → 读 dev 产物
- `node dist/main` 不设 → 默认 `dist`，读 prod 产物

`createAppBase` 内部无 `if (isDev)` 分支：统一水合 `faapi-routes.js` 路由清单，统一 `loadConfig(dist)` 读配置，统一按需 import `zod.js` 做 zod safeParse。

## 使用场景

### prod 模式（dist/main.js 内部）

`faapi build` 生成 `dist/main.js` 启动入口，内部调用 `createProdApp` + `listen`，读 `dist/` 产物：

```js
// dist/main.js（由 faapi build 自动生成）
import { createProdApp } from '@faapi/faapi';
const app = await createProdApp();
await app.listen();
```

### dev 模式（devCommand 内部）

`faapi dev` 直接调用 `createDevApp` + `listen`，读 `.faapi/` 产物：

```ts
// devCommand.ts 内部
const app = await createDevApp({ rootDir });
await app.listen();
startWatcher({ rootDir, app });
```

dev 模式不运行用户入口文件——devCommand 直接持有 app 引用后传给 watcher。

### 编程式调用（自定义场景）

用户需要在自定义启动器中使用时，可直接调用 API：

```ts
import { createProdApp } from '@faapi/faapi';
const app = await createProdApp();
await app.listen(3000);
```

`createApp` 为 `createProdApp` 的别名，向后兼容。

## App 实例方法

### AppBase（dev/prod 共用）

| 方法 | 说明 |
|------|------|
| `listen(port?)` | 启动 HTTP server，打印路由表，执行 onReady 钩子 |
| `close()` | 关闭 server，执行 onClose 钩子 |

### DevApp（AppBase + reloadRoutes）

| 方法 | 说明 |
|------|------|
| `reloadRoutes()` | 重新扫描路由 + 重新生成 schema + 清缓存 + 更新 server 路由引用（dev 热替换用） |

## reloadRoutes 实现说明（createDevApp 专用）

`reloadRoutes` 不重新 import `faapi-routes.js`——ESM 模块缓存难以通过 `?t=timestamp` URL 参数可靠绕过。改为直接调 `scanRoutes` 重新扫描源码 + `generateSchemaFiles` 重新生成 schema：

1. 更新模块加载时间戳（`setLoadTimestamp(Date.now())`，其他 import 绕过缓存用）
2. 清理中间件 + Program + schema 缓存（`invalidateMiddlewareCache` / `invalidateProgramCache` / `invalidateSchemaCache`）
3. `scanRoutes(rootDir, patterns, dist)` 重新扫描
4. `generateSchemaFiles` 重新生成 `zod.js`
5. `ctx.updateRoutes` 更新 `app.routes` / `app.wsRoutes` 和 `routesRef.current` / `routesRef.wsCurrent`（server 使用最新路由）

prod 模式（createProdApp）不包含 `reloadRoutes`——产物已固化，运行时不重建。

## 相关模块

- `./createAppCore.ts` - dev/prod 共享的 `createAppBase` 编排核心 + `AppBase`/`AppContext` 类型
- `./createDevApp.ts` - dev 入口（createAppBase + reloadRoutes）
- `./createProdApp.ts` - prod 入口（createAppBase，精简）
- `./createApp.ts` - `createProdApp` 的向后兼容别名
- `./buildCommand.ts` - `faapi build` 命令，生成 `dist/main.js` 启动入口（内部调用 `createProdApp` + `listen`）
- `./devCommand.ts` - `faapi dev` 命令，内部调用 `createDevApp` + `listen`
- `../server/createServer.ts` - `createAppBase` 内部调用，创建底层 HTTP server
- `../config/loadConfig.ts` - `createAppBase` 统一读 `<dist>/faapi-config.js`
- `./generateRoutes.ts` - 水合 `faapi-routes.js` 路由清单（hydrateRoutes）
- `../router/scanRoutes.ts` - `reloadRoutes` 重新扫描路由
- `./generateSchemaFiles.ts` - `reloadRoutes` 重新生成 zod.js
- `./loadPlugins.ts` - 加载 `config.plugins` 声明的插件
- `./watcher.ts` - `faapi dev` 的 watcher 接收 app 引用，调用 `app.reloadRoutes()` 实现热替换
