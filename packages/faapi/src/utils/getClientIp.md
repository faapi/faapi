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

优先级：

1. `x-forwarded-for` 第一个 IP（反向代理场景）
2. `req.socket.remoteAddress`（直连场景）

IPv6 形式 `::ffff:127.0.0.1` 会被规整为 `127.0.0.1`。无法获取时返回空字符串。

## 安全注意

`x-forwarded-for` 仅在受信任的反向代理后才有效。若客户端直连且未经过代理，该 header 可被伪造。生产环境建议在反向代理层（nginx）覆盖该 header。

## 相关模块

- [runtime/createContext](../runtime/createContext.ts) — 接收 ip 参数，存到 ctx.ip
- [injection/injectParams](../injection/injectParams.ts) — `ip` 参数名注入 ctx.ip
