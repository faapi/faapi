# helmet

一句话概括：安全 HTTP 响应头中间件（类似 `helmet` npm 包），通过设置 13 个安全相关 HTTP 头（CSP、X-Frame-Options、HSTS、X-Content-Type-Options 等）增强应用安全性。框架自带实现，不依赖第三方 `helmet` 包。

## 为什么需要

Web 应用需要设置一组安全响应头防御常见攻击：CSP 防 XSS、X-Frame-Options 防点击劫持、HSTS 强制 HTTPS、X-Content-Type-Options 防 MIME 嗅探等。手写易遗漏且默认值不易记忆。

`helmet` 提供社区认可的合理默认值，用户可通过传 `false`（opt-out）关闭特定头，或传自定义值覆盖默认值。作为洋葱中间件实现，在 `await next()` 之前设置头，对所有路由生效。

## 使用场景

- `faapi.config.ts` 的 `helmet` 选项配置（`HelmetOptions | boolean`）
- `createServer` 在中间件链最外层注册 helmet（`configMiddlewares.push(helmet(helmOpts))`）
- 全局生效：所有 HTTP 路由 + WS 握手阶段都经过 helmet

```ts
// faapi.config.ts
export default {
  helmet: true,                    // 启用全部默认安全头
  // 或精细配置
  helmet: {
    contentSecurityPolicy: "default-src 'self'; script-src 'self'",
    xFrameOptions: 'DENY',
    strictTransportSecurity: false, // 关闭 HSTS（如本地开发）
  },
} satisfies FaapiConfig;
```

## 安全头清单

| 头 | 默认值 | opt-out |
|----|--------|---------|
| Content-Security-Policy | `default-src 'self'` | `contentSecurityPolicy: false` |
| X-Frame-Options | `SAMEORIGIN` | `xFrameOptions: false` |
| X-Content-Type-Options | `nosniff` | `xContentTypeOptions: false` |
| Referrer-Policy | `no-referrer` | `referrerPolicy: false` |
| Strict-Transport-Security | `max-age=31536000; includeSubDomains` | `strictTransportSecurity: false` |
| X-DNS-Prefetch-Control | `off` | `xDnsPrefetchControl: false` |
| X-Download-Options | `noopen` | `xDownloadOptions: false` |
| X-Permitted-Cross-Domain-Policies | `none` | `xPermittedCrossDomainPolicies: false` |
| Cross-Origin-Opener-Policy | `same-origin` | `crossOriginOpenerPolicy: false` |
| Cross-Origin-Resource-Policy | `same-origin` | `crossOriginResourcePolicy: false` |
| Cross-Origin-Embedder-Policy | （默认关闭） | 设为非 false 字符串启用 |
| Origin-Agent-Cluster | `?1` | `originAgentCluster: false` |
| X-Powered-By | `faapi` | `xPoweredBy: false` |

## 相关模块

- `createServer.ts` - 在中间件链最外层注册 helmet
- `configTypes.ts`（config）- `helmet?: HelmetOptions | boolean` 配置项
- `middlewareTypes.ts` - `FaapiMiddleware` 类型
- `index.ts` - 公开导出 `helmet` 函数和 `HelmetOptions` 类型
