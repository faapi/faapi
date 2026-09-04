---
'@faapi/faapi': minor
---

新增 `trustedProxy` 配置（默认 `false`），`ctx.ip` 默认不再信任 `X-Forwarded-For`。

此前 `getClientIp` 无条件取 XFF 第一个 IP——客户端直连时该 header 可被任意伪造，污染 `ctx.ip`（影响限流/日志/访问控制）。现在的行为：

- `trustedProxy: false`（默认）：直取 socket 地址，XFF 被忽略——直连部署防伪造
- `trustedProxy: true`：沿用原行为，取 XFF 第一个 IP——部署在 nginx/CDN 等受信任反向代理之后时在 `faapi.config.ts` 显式开启

**升级注意**：部署在反向代理之后、依赖 `ctx.ip` 为客户端真实 IP 的项目需显式配置 `trustedProxy: true`，否则 `ctx.ip` 会变为代理的 socket 地址。同时影响 HTTP 与 WebSocket 握手。
