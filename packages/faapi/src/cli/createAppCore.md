# createAppCore

一句话概括：dev/prod 共享的应用基础编排核心——完成「配置加载 → 路由清单水合 → tool 清单水合 → 创建 server → 插件加载」，返回 `AppBase`（listen/close/inject）+ `AppContext`（供 dev 扩展 reloadRoutes）；另导出 `getApp()` 用于在拿不到 app 引用的场景（如 Next.js RSC）访问单例。

## 为什么需要

faapi 的核心架构决策是「dev/prod 走完全一致的读产物代码路径，差异仅由 `FAAPI_DIST` 环境变量驱动，无 `if (isDev)` 控制流分支」。`createAppBase` 是这个统一路径的实现：

- 不负责编译 TypeScript——编译由 `faapi dev`（esbuild → `.faapi/`）和 `faapi build`（→ `dist/`）负责
- 不负责生成路由清单——`faapi dev`/`faapi build` 启动时生成 `faapi-routes.js`，`createAppBase` 直接水合
- 只负责读产物三元组（`faapi-config.js` + `faapi-routes.js` + `zod.js`）并组装成可运行的应用

dev 的 `createDevApp` 在 `createAppBase` 基础上增加 `reloadRoutes`（热替换）+ `setLoadTimestamp`（缓存失效）；prod 的 `createProdApp` 直接返回 `AppBase`。

## 使用场景

- `createDevApp`（dev 模式）调 `createAppBase` 获取 `app` + `ctx`，基于 `ctx.updateRoutes` 实现 `reloadRoutes`
- `createProdApp`（prod 模式）调 `createAppBase` 仅取 `app`，丢弃 `ctx`
- 编程式调用场景（自定义启动器、测试场景）
- `getApp()` 用于拿不到 app 引用的场景（如 Next.js Server Component 同进程调用 faapi API）

`dist` 由 `process.env.FAAPI_DIST` 决定：`faapi dev` 设为 `.faapi`，`node dist/main` 不设（默认 `dist`）。

## API

### CreateAppOptions

| 字段 | 说明 |
|------|------|
| `rootDir` | 项目根目录，默认 `process.cwd()` |
| `port` | 端口号，也可在 `listen()` 时传入；默认 `PORT` 环境变量或 `3000` |

### AppBase

| 方法 | 说明 |
|------|------|
| `listen(port?)` | 启动 HTTP server，打印路由表，执行 `onReady` 钩子，注册优雅关闭信号（仅当配置了 `onClose`） |
| `close()` | 幂等关闭 server，执行 `onClose` 钩子，`app.server` 置 null；若单例仍指向当前 app 则置 null |
| `inject(options?)` | 无服务器测试注入——构造模拟请求直接走完整请求链路（CORS / helmet / logger / 全局中间件 / 路由匹配 / schema 校验 / 目录中间件 / handler），不绑定端口，返回已解析的 `{ status, headers, body }`。`listen()` 前后均可调用——`listen()` 后调用常用于 Next.js Server Component 等同进程场景（配合 `getApp()` 拿到 app 实例） |

端口优先级：`listen()` 参数 > `options.port` > `PORT` 环境变量 > 默认 `3000`。

### getApp()

```ts
export function getApp(): AppBase;
```

获取当前 faapi app 单例。用于在无法直接拿到 app 引用的场景（如 Next.js Server Component）中访问 app。

- **未初始化时抛错**（强约束，立刻发现问题）
- **`createAppBase` 末尾设置单例**（覆盖之前的实例）
- **`close()` 时清 null**（仅当单例仍指向当前 app，避免被后续 app 误清）
- **通过 `globalThis` + `Symbol.for('faapi.app.instance')` 共享单例**——Next.js 16 默认用 Turbopack 作为 `next dev` 的 bundler，Turbopack dev server runtime 与主进程的 Node.js 原生 module cache 是两套独立缓存，模块级变量无法跨实例共享。用 `globalThis` 确保 RSC chunk 中的 `getApp()` 能读到主进程 `faapi dev` 设置的 app 引用。生产模式（`node dist/main`）不受此问题影响——`next build` 产物是普通 JS 文件，运行时通过 Node.js 原生 require 加载，与主进程共享 module cache。

**Next.js RSC 场景用法**：

```ts
// app/page.tsx
import { getApp } from '@faapi/faapi';
import { headers } from 'next/headers';

async function Page() {
  const h = await headers();
  const app = getApp();
  const res = await app.inject({
    method: 'GET',
    path: '/api/user',
    headers: { cookie: h.get('cookie') ?? '', authorization: h.get('authorization') ?? '' },
  });
  const data = res.body;  // 已解析，无需 await res.json()
  return <div>{data.name}</div>;
}
```

### AppContext

供 dev 扩展 `reloadRoutes` 使用，prod 模式不使用：

| 字段 | 说明 |
|------|------|
| `rootDir` / `dist` | 路径上下文 |
| `patterns` | scanRoutes 用的 glob 模式 |
| `server` | 未 listen 的 Server 实例 |
| `routesRef` | 路由可变引用容器（createServer 闭包和 reloadRoutes 共享） |
| `config` | 原始 FaapiConfig 或 null |
| `updateRoutes(routes, wsRoutes)` | 同步更新 app.routes/wsRoutes + routesRef + 闭包变量 |

## 关键行为

- 路由清单缺失（`<dist>/faapi-routes.js` 不存在）→ 抛错（含 build/dev 提示）
- tool 清单缺失（`<dist>/faapi-tools.js` 不存在）→ 跳过水合，toolRegistry 保持空（tool 是可选能力，纯 API 项目无 tool）
- 路由冲突 → 仅 `console.warn`，不阻断启动
- `listen` 打印路由表 + tool 清单（有 tool 时），仅当配置了 `lifecycle.onClose` 时注册 SIGTERM/SIGINT 优雅关闭
- `close` 幂等（`closed` 标志）；`close` 时清理 toolRegistry 单例（与 app 单例清理对称）；HTTP/2 连接清理方法 feature-detect
- `inject` 无 handler 时 reject；`JSON.parse` 失败回退为字符串

`loadAndHydrateTools(rootDir, dist)` 导出供 `reloadTools` 热替换后重新水合——读 `faapi-tools.js` → `hydrateTools` → `hydrateToolRegistry`。

## 相关模块

- `createDevApp.ts` - dev 模式启动，基于 `createAppBase` 增加 `reloadRoutes` + `reloadTools`（重新生成 + 重新水合 tool 清单）
- `createProdApp.ts` - prod 模式启动，直接委托 `createAppBase`
- `createApp.ts` - `createProdApp` 的向后兼容别名
- `loadConfig.ts` - 读 `<dist>/faapi-config.js`
- `createServer.ts` - 创建 HTTP server + 路由匹配 + 请求处理
- `loadPlugins.ts` - 加载插件并返回 handler/upgrade 包装器
- `startServer.ts` - `applyPluginWrappers` 应用包装器到 server
- `generateRoutes.ts` - `hydrateRoutes` 水合序列化路由清单
- `generateToolArtifacts.ts` - `hydrateTools` 水合序列化 tool 清单 + 生成 `faapi-tools.js`
- `toolRegistry.ts` - tool 注册表单例（`hydrateToolRegistry` / `getTool` / `listTools`）
- `importWithCacheBust.ts` - 加载路由/tool 清单（watch 模式带时间戳绕缓存）
