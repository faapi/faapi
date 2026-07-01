# @faapi/next

一句话概括：Next.js + faapi 集成插件，通过 faapi.config.ts 的 plugins 字段加载，单进程单端口按路径前缀分流——`/api/*` 走 faapi，其余走 Next.js。

## 为什么需要

faapi 和 Next.js 是两个独立框架，各自有完整的请求处理逻辑。集成时通常需要写 custom server 代码手动分流，繁琐且容易出错（WS upgrade 分流、HMR 处理等）。

`@faapi/next` 作为 faapi 插件，通过 `ctx.wrapHandler` / `ctx.wrapUpgradeHandler` 在 server.listen 之前包装请求处理逻辑：

- `/api/*` 走 faapi handler
- 其余走 Next.js `getRequestHandler()`
- WS upgrade 同步分流：faapi WS 路由走原始 upgrade handler，其余走 Next.js HMR（dev 模式）

用户在 `faapi.config.ts` 中声明插件，用 `faapi` 命令启动，无需写 custom server 代码。

## 使用场景

### 1. 基本用法（faapi.config.ts 声明）

```ts
// faapi.config.ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  plugins: [
    '@faapi/next',                           // 包名
    // 或 ['@faapi/next', { dir: '.' }],      // 带选项
    // 或 { package: '@faapi/next', enable: true },
  ],
} satisfies FaapiConfig;
```

```bash
# 安装
pnpm add @faapi/faapi @faapi/next next

# 启动（faapi 主 CLI，自动加载 @faapi/next 插件）
faapi
```

项目结构：

```
project/
├── src/api/              ← faapi 路由
│   └── user/handler.ts
├── app/                  ← Next.js App Router
│   └── page.tsx
├── faapi.config.ts       ← faapi 配置（声明 @faapi/next 插件）
├── next.config.ts        ← Next.js 配置
└── package.json
```

### 2. 插件选项

```ts
export default {
  plugins: [
    ['@faapi/next', {
      dev: true,           // 开发模式，默认 NODE_ENV !== 'production'
      dir: '.',            // Next.js 项目目录，默认 '.'
      apiPrefix: '/api',   // faapi API 路径前缀，默认 '/api'
    }],
  ],
} satisfies FaapiConfig;
```

### 3. API 前缀

`apiPrefix` 决定哪些请求走 faapi（默认 `/api`）。faapi 路由 URL 由文件路径推导（`src/api/user/handler.ts` → `/api/user`），因此 `apiPrefix` 应与 faapi 路由前缀保持一致，默认 `/api` 无需额外配置。

## 设计要点

- **作为 faapi 插件实现**：实现 `FaapiPlugin` 接口，通过 `faapi.config.ts` 的 `plugins` 字段加载，不提供独立 CLI
- **next 作为 optional peerDependency**：未安装时 `import('next')` 报错，提示用户安装
- **动态 import**：`await import('next')` 而非顶层 import，确保未装 next 时包仍可加载（仅 setup 时报错）
- **通过 wrapHandler 分流**：在 setup 中调用 `ctx.wrapHandler` 注册包装函数，框架在 listen 之前应用
- **WS 分流**：通过 `ctx.wrapUpgradeHandler` 注册，faapi WS 路由走原始 handler，其余走 Next.js HMR
- **dev 模式自动推断**：`NODE_ENV !== 'production'` 即 dev 模式
- **配置分离**：faapi 配置在 `faapi.config.ts`，Next.js 配置在 `next.config.ts`

## 请求分流规则

```
HTTP 请求:
  pathname === '/api'           → faapi
  pathname.startsWith('/api/')  → faapi
  其余                           → Next.js

WS upgrade:
  pathname 匹配 /api/* 且 faapi 有 WS 路由  → faapi upgradeHandler
  其余                                      → Next.js HMR（dev 模式）
```

**边界情况**：`/api2` 不匹配 `/api` 前缀（精确匹配前缀 + 斜杠）。

## 插件加载流程

```
1. faapi CLI 启动
2. createServer（创建 server，不 listen）
3. beforeListen 钩子：
   a. loadPlugins 遍历 config.plugins
   b. 动态 import '@faapi/next'，取 default
   c. 调用 plugin.setup(ctx)
   d. setup 中：import next → prepare → ctx.wrapHandler → ctx.wrapUpgradeHandler
   e. loadPlugins 返回收集到的 wrappers
4. applyPluginWrappers（替换 server 的 request/upgrade listener）
5. server.listen
6. onReady 钩子
```

## 限制

1. **prod 模式 build**：用户需分别执行 `faapi build` 和 `next build`，然后用 `faapi start` 启动
2. **Next.js getUpgradeHandler 非公开 API**：依赖 Next.js 内部实现，未来大版本可能变化
3. **静态资源**：Next.js 的静态资源（`/public`、`/_next/static`）由 Next.js handler 自动处理，faapi 不参与

## 相关模块

- `@faapi/faapi` 的 `FaapiPlugin` 接口 - 本插件实现该接口
- `@faapi/faapi` 的 `PluginContext.wrapHandler` / `wrapUpgradeHandler` - 插件通过这两个方法注册包装函数
- `next` 包 - Next.js 框架，插件动态 import
- `@faapi/schema` - 可与本插件共存，schema 通过 faapi.config.ts 的 plugins 数组同时声明
