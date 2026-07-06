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

## 许可证

[MIT](https://github.com/faapi/faapi/blob/main/LICENSE)
