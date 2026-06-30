---
"@faapi/faapi": minor
---

新增内置注入参数 `ip`：handler 通过 `ip` 参数名接收客户端 IP。

```ts
// src/api/user/handler.ts
export function GET(ip: string) {
  return { clientIp: ip };  // 203.0.113.1
}
```

也可通过 `ctx.ip` 访问：

```ts
export function GET(ctx) {
  return { clientIp: ctx.ip };
}
```

**IP 来源**：优先 `x-forwarded-for` 第一个 IP（反向代理场景），回退到 `req.socket.remoteAddress`。IPv6 形式 `::ffff:1.2.3.4` 规整为 IPv4 `1.2.3.4`。HTTP 和 WebSocket 握手阶段均注入。
