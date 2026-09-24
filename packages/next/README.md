# @faapi/next

> Next.js + faapi 单进程单端口集成

`@faapi/next` 让 faapi 和 Next.js 运行在同一个进程中，共享同一个端口。`/api/*` 路径走 faapi，其余路径走 Next.js，无需写 custom server 代码。

## 安装

```bash
pnpm add @faapi/next next
# 或
npm install @faapi/next next
```

要求 Node.js >= 24，Next.js >= 13。

## 快速开始

在 `faapi.config.ts` 中声明插件：

```ts
export default {
  plugins: ['@faapi/next'],
} satisfies FaapiConfig;
```

然后像普通 faapi 项目一样启动：

```bash
npx faapi
```

`/api/*` 的请求由 faapi handler 处理，其余请求（页面、静态资源、HMR）由 Next.js 处理。

### 自定义 API 前缀

```ts
export default {
  plugins: [
    ['@faapi/next', { apiPrefix: '/v1' }],
  ],
} satisfies FaapiConfig;
```

### 生产模式

```bash
npx faapi build
node dist/main
```

## HTTP 分流

| 请求路径 | 处理方 |
|----------|--------|
| `/api/user` | faapi handler |
| `/api/hello?name=world` | faapi handler |
| `/` | Next.js 首页 |
| `/about` | Next.js 页面 |
| `/api2`（不匹配 /api 前缀） | Next.js |
| `/_next/*`（HMR / 静态资源） | Next.js |

## WebSocket 分流

| upgrade 请求 | 处理方 |
|-------------|--------|
| `/api/chat`（faapi WS 路由） | faapi WebSocket handler |
| `/_next/webpack-hmr` | Next.js HMR |

## 浏览器端请求层（`@faapi/next/client`）

客户端组件（`'use client'`）的 API 请求统一走 `apiCall`，它封装了 fetch + faapi 信封（`{ data }` / `{ error }`）解包，失败一律抛结构化 `ApiError`（携带 `code` / `status` / `message`，`VALIDATION_ERROR` 时附 `issues`）：

```tsx
'use client';
import { apiCall, ApiError } from '@faapi/next/client';

async function submit() {
  try {
    const user = await apiCall<{ id: number }>('/api/user', { method: 'POST' });
    toast.success('已保存');
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e)); // message 恒为可读文案
  }
}
```

### 为什么需要 apiCall

`/api/*` 的错误响应恒为 JSON 信封，但链路其他层会返回 HTML（反代/网关错误页、Next.js 404 页、SSO 登录守卫的 302 重定向）。直接 `res.json()` 会把裸 `Unexpected token '<'` SyntaxError 原文抛上界面。`apiCall` 把这些异常响应转译为可行动的中文提示（502/503 → 服务暂时不可用、504 → 服务响应超时、401 → 登录已过期、登录页重定向 → 登录状态已失效），排障现场（状态码 / URL / body 前 200 字符）留在 `console.error`。`statusMessage` 一并导出，可 fork 自定义文案。

### ⚠️ 必须用 `@faapi/next/client` 子路径导入

主入口 `@faapi/next` 是**服务端插件**（依赖 `@faapi/faapi` 与 next 服务端模块）。客户端组件若误用主入口，会把 `node:fs` / `node:child_process` 等服务端代码拉进浏览器 bundle，导致 Next.js build 失败。客户端代码只从 `@faapi/next/client` 导入；`./client` 入口零 Node 依赖，可安全进入客户端 bundle。

### 已知限制

`apiCall` 按主包 `config.response` 的**默认信封**解包。若你在 `faapi.config.ts` 自定义了 `response.ok` / `response.fail`，请自行包装 apiCall（替换解包段），不要两处各改各的。

## 许可证

[MIT](https://github.com/faapi/faapi/blob/main/LICENSE)
