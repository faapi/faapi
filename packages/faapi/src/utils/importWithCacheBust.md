# importWithCacheBust

一句话概括：动态 import ESM 模块，watch 模式下通过 URL query 参数（`?t=<timestamp>`）绕过 ESM 缓存；vitest 环境下自动走 Vite SSR pipeline 识别 tsconfig paths 别名 + `vi.mock`。非 watch / 非 vitest 模式等价于普通 `import()`。

## 为什么需要

### 缓存绕过（dev/watch 模式）

ESM 模块按 URL 缓存，同一 URL 的 `import()` 第二次返回缓存的模块对象。dev/watch 模式下文件变化后需要重新加载，但 URL 不变则 `import()` 返回旧缓存，热替换失效。

`importWithCacheBust` 在 URL 后追加 `?t=<timestamp>` query 参数，让每次 reload 的 URL 唯一，强制 Node.js ESM loader 重新加载文件内容。`loadTs` 未设置时（prod 模式或 dev 首次加载）不追加 query，等价普通 `import()`。

`setLoadTimestamp` 由 `createDevApp.reloadRoutes` 在每次热替换时调用，设置新的时间戳。ES 模块单例保证所有 import 此模块的地方共享同一个 `loadTs` 值，无需 `globalThis`。

### vitest 环境走 Vite pipeline

业务方在 vitest 下用 `createTestServer` 启动 in-memory 测试服务器时，handler 文件通过 `importWithCacheBust` 加载。但 Node 原生 ESM `import()` 不识别 TypeScript `paths` 别名（如 `@/lib/db`），也不让 `vi.mock` 生效（mock 只在 Vite module pipeline 内有效）。

`importWithCacheBust` 检测 `globalThis.vi.importActual`（vitest `globals: true` 时注入的全局），优先走 `vi.importActual(filePath)` 加载模块。`vi.importActual` 走 Vite SSR pipeline：
- 识别 `vitest.config.ts` 的 `resolve.alias` 与 tsconfig paths 别名
- 让 `vi.mock` 在加载的模块内生效

业务方 vitest.config.ts 需满足以下任一条件：
- `test.globals: true`（推荐，`globalThis.vi` 自动注入）
- 测试文件内显式 `import { vi } from 'vitest'` 后挂到 `globalThis.vi`（仅在该测试文件作用域内生效）

不在 vitest 环境下（`globalThis.vi` 不存在）时回退到 Node 原生 `import()`，无副作用。

## 使用场景

- watch 模式热替换：`createDevApp.reloadRoutes` 调 `setLoadTimestamp(Date.now())`，随后所有 `importWithCacheBust` 带时间戳重新加载
- 路由模块加载：`loadRouteModule` 用本函数加载 handler.js
- 中间件加载：`loadMiddlewares` 用本函数加载用户中间件模块
- schema 加载：`validateInput` 用本函数加载生成的 zod.js
- 配置加载：`loadConfig` 用本函数加载 faapi-config.js
- WS handler 加载：`handleWsUpgrade` 用本函数加载 handler.ts 的 WS 导出
- 路由清单水合：`createAppCore` 用本函数加载 faapi-routes.js
- 路由扫描：`scanRoutes` 用本函数加载模块获取导出方法名
- **业务方测试**：`createTestServer` 在 vitest 下加载含 `@/` 别名的 handler，并让 `vi.mock` 生效

## API

```ts
function setLoadTimestamp(ts: number): void
function importWithCacheBust(filePath: string): Promise<Record<string, unknown>>
```

`filePath` 须为绝对路径，内部用 `pathToFileURL` 转为 `file://` URL。无显式 try/catch——`import()` / `importActual` 失败（模块不存在/语法错误/别名解析失败）异常直接向上传播。

## 相关模块

- `createDevApp.ts` - 调 `setLoadTimestamp` 开启缓存失效模式
- `loadRouteModule.ts`（loader）- 加载路由模块
- `loadMiddlewares.ts`（middleware）- 加载用户中间件
- `validateInput.ts`（validator）- 加载 zod.js
- `loadConfig.ts`（config）- 加载 faapi-config.js
- `handleWsUpgrade.ts`（server）- 加载 WS handler
- `createAppCore.ts`（cli）- 加载路由清单
- `scanRoutes.ts`（router）- 扫描时加载模块
- `testServer.ts`（test）- 业务方 E2E 测试服务器，vitest 下自动走 Vite pipeline
