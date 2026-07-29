---
"@faapi/faapi": minor
---

新增 `ua` 注入类型：handler 可通过 `ua` 参数名注入客户端 User-Agent（请求头 `user-agent` 原值），`ctx.ua` 字段可直接访问。与 `ip` 对称，UA 在 `createContext` 内联从请求头读取（无需调用方传入），HTTP 与 WebSocket 握手均自动支持。
