# getClientIp

从 Node.js `IncomingMessage` 提取客户端 IP。

## 为什么需要

handler 注入 `ip` 参数时需要从请求中提取客户端 IP。HTTP 请求可能经过反向代理（nginx/CDN）或直连，两种场景 IP 来源不同：

- 反向代理：`x-forwarded-for` 请求头第一个 IP
- 直连：`req.socket.remoteAddress`

## 使用场景

- `createServer.ts` HTTP 请求处理时提取 IP，传入 `createContext`
- `handleWsUpgrade.ts` WebSocket 握手阶段提取 IP，传入 `createContext`

## 行为

```ts
getClientIp(req, trustedProxy = false): string
```

- **`trustedProxy=true`**（部署在受信任反向代理之后）：`x-forwarded-for` 第一个 IP 优先，无该头时回退 socket 地址
- **`trustedProxy=false`（默认）**：忽略 `x-forwarded-for`，直取 `req.socket.remoteAddress`

IPv6 形式 `::ffff:127.0.0.1` 会被规整为 `127.0.0.1`。无法获取时返回空字符串。

## 安全注意：为什么默认不信任 XFF

`x-forwarded-for` 是普通请求头——客户端直连服务时可以**任意伪造**（如 `curl -H 'X-Forwarded-For: 1.2.3.4'`），污染 `ctx.ip`，进而欺骗基于 IP 的限流 / 日志 / 访问控制。

因此默认 `trustedProxy=false`（安全默认）。部署在受信任的反向代理之后时，在 `faapi.config.ts` 显式开启：

```ts
export default {
  trustedProxy: true, // nginx/CDN 场景：ctx.ip 取 X-Forwarded-For 第一个 IP
} satisfies FaapiConfig;
```

同时影响 HTTP 请求与 WebSocket 握手的 `ctx.ip`。

## 相关模块

- [runtime/createContext](../runtime/createContext.ts) — 接收 ip 参数，存到 ctx.ip
- [injection/injectParams](../injection/injectParams.ts) — `ip` 参数名注入 ctx.ip
- [config/configTypes](../config/configTypes.md) — `trustedProxy` 配置字段
