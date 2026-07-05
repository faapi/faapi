# 场景:CORS 配置

## 何时加载

用户要配置 CORS（跨域资源共享）。

## 配置方式

CORS 仅通过 `faapi.config.ts` 的 `cors` 字段配置。dev 模式默认启用 CORS。

```ts
export default {
  cors: { origin: ['https://example.com'], credentials: true },
} satisfies FaapiConfig;
```

```ts
export default {
  cors: {
    origin: '*',               // 允许的源，'*' 表示全部
    credentials: true,         // 是否允许携带 cookie
    methods: ['GET', 'POST'],  // 允许的 HTTP 方法
    maxAge: 86400,             // 预检请求缓存时间（秒）
  },
} satisfies FaapiConfig;
```

禁用 CORS：

```ts
export default {
  cors: false,
} satisfies FaapiConfig;
```
