# HTTP 服务器

HTTP 服务器创建与启动，将 Node.js 原生 HTTP 服务与 faapi 路由系统对接。

## 模块

| 模块 | 说明 |
| --- | --- |
| [createServer.ts](./createServer.ts) | 核心请求处理：创建 HTTP 服务、请求分发、错误处理 |
| [startServer.ts](./startServer.ts) | 启动服务并打印路由表 |
| [handleWsUpgrade.ts](./handleWsUpgrade.ts) | WebSocket upgrade 握手处理 |
| [serverUtils.ts](./serverUtils.ts) | Node.js ↔ Web 类型转换、错误响应构建 |

## 请求流程

```
IncomingMessage
  → toWebRequest（转为 Web Request）
  → CORS before 钩子（路由匹配前执行，确保 OPTIONS 预检正常）
  → matchRoute（路由匹配）
  → loadRouteModule（加载路由模块）
  → resolveInput（解析输入：query/body/multipart）
  → validateInput（校验输入）
  → createContext（创建上下文）
  → invokeHandler（调用 handler + 中间件链）
  → sendNodeResponse（写入 Node.js 响应）
```

## CORS 处理

CORS 在路由匹配前执行，确保 OPTIONS 预检请求能正常返回 CORS 头，而不被 404 拦截。非预检请求时，CORS 头存储在响应 meta 中，随最终响应一起返回。

## 相关模块

- [router](../router/README.md)：路由匹配
- [loader](../loader/README.md)：模块加载
- [runtime](../runtime/README.md)：上下文创建与 handler 调用
- [validator](../validator/README.md)：输入校验
- [response](../response/README.md)：响应处理
- [errors](../errors/README.md)：错误处理
