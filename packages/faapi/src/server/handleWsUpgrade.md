# handleWsUpgrade

一句话概括：处理 WebSocket 协议升级请求，匹配 WS 路由后走洋葱中间件链，完成握手和事件绑定。

## 为什么需要

faapi 的 WebSocket 支持需要拦截 HTTP upgrade 请求，将匹配到的路由升级为 WebSocket 连接。握手阶段需要复用洋葱中间件链（鉴权/CORS/限流/日志等），连接建立后切到事件模型。`handleWsUpgrade` 封装了路由匹配、中间件执行、协议升级、事件绑定的完整流程。

## 使用场景

- server 启动时调用 `attachWebSocket` 挂载 upgrade 处理
- 客户端发起 WebSocket 连接时自动匹配 WS 路由
- 中间件拦截握手（如鉴权失败）→ 返回 HTTP 错误响应，不升级
- 中间件放行 → 完成协议升级，绑定事件回调

## API

| 方法 | 说明 |
|------|------|
| `attachWebSocket(options)` | 在 HTTP server 上挂载 WebSocket 升级处理，返回 `WebSocketServer` 实例 |

### AttachWsOptions

| 字段 | 说明 |
|------|------|
| `server` | HTTP Server 实例 |
| `wsRoutes` | WS 路由清单（watch 模式下可热更新） |
| `rootDir` | 项目根目录 |
| `config` | 业务配置，注入到 WsContext.config |
| `errorFormat` | 错误响应格式化函数（来自 faapi.config.ts） |
| `globalMiddlewares` | 全局中间件（WS 握手最外层） |
| `globalInjectors` | 全局注入器 |

## 握手流程

1. 监听 HTTP server 的 `upgrade` 事件
2. 从 `globalRef.__FAAPI_WS_ROUTES__` 获取最新 WS 路由（支持 watch 热更新）
3. 路由匹配失败 → 返回 404 并销毁 socket
4. 路由匹配成功 → 构造 `FaapiContext`，执行中间件链：
   - 中间件拦截（返回 Response）→ 把 Response 写回 socket 后销毁，不升级
   - 中间件放行 → `finalHandler` 内调用 `ws.handleUpgrade` 完成协议升级
5. 协议升级后绑定事件回调（`onOpen`/`onMessage`/`onClose`/`onError`）

中间件链顺序：全局中间件（外）→ 目录中间件（内）→ finalHandler。

## 相关模块

- [runtime/wsHandler.ts](../runtime/wsHandler.md) - WsContext / WsEventHandlers / WsSocket 封装
- [router/matchRoute.ts](../router/matchRoute.ts) - WS 路由匹配
- [runtime/createContext.ts](../runtime/createContext.ts) - 构造请求上下文
- [runtime/invokeHandler.ts](../runtime/invokeHandler.md) - `compose` 洋葱中间件执行
- [errors/formatErrorResponse.ts](../errors/formatErrorResponse.ts) - 内置错误响应格式化
