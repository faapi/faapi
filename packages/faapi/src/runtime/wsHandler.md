# WebSocket Handler

一句话概括：faapi 的 WebSocket 支持模块，定义 WS 连接的事件回调和类型约定。

## 为什么需要

faapi 现有 HTTP 请求模型是"请求-响应"闭环（`Request → Response`），无法承载长连接的双向通信场景：
- 聊天室、协同编辑、实时通知需要服务端主动推送 + 客户端持续发消息
- LLM agent 的交互式对话（HITL 审批）需要双向通道
- 监控面板需要持续推送指标数据

SSE 解决了"服务端推送"，但客户端只能通过新 HTTP 请求发消息；WebSocket 提供真正的双向长连接，与 SSE 互补。

## 使用场景

用户在 `api/**/handler.ts` 中导出 `WS` 函数即可声明 WebSocket 路由：

```ts
// api/chat/handler.ts
import type { WsContext } from '@faapi/faapi';

export function WS(ctx: WsContext) {
  return {
    onOpen(ws) {
      ws.send('connected');
    },
    onMessage(ws, message) {
      ws.send(`echo: ${message}`);
    },
    onClose(ws, code, reason) {
      console.log('closed', code);
    },
    onError(ws, error) {
      console.error('ws error', error);
    },
  };
}
```

- 与 `GET`/`POST` 同级，导出名 `WS` 即声明 WebSocket 路由
- 返回事件对象（`onOpen`/`onMessage`/`onClose`/`onError`），不直接操作原生 socket
- `ctx` 在握手阶段构造，包含 `params`/`query`/`headers`/`config`，事件回调通过闭包访问

## 设计要点

1. **路由级声明**：WS 路由与 HTTP 路由统一在 `handler.ts` 中，扫描器识别 `WS` 导出
2. **事件对象 API**：返回 `{ onOpen, onMessage, onClose, onError }`，不暴露 `ws` 库原生 socket
3. **握手阶段构造 WsContext**：协议升级前提取 `params`/`query`/`headers`/`config`，传入 WS handler
4. **两阶段中间件策略**：
   - 握手阶段（HTTP upgrade 请求）：复用洋葱中间件链，与同目录 HTTP 路由共享鉴权/CORS/限流/日志。中间件塞入 ctx 的值（如 `ctx.user`）传入 WS handler
   - 事件回调阶段（连接建立后）：不走洋葱中间件（长连接事件流非请求-响应闭环，`await next()` 语义不符），由 WS handler 自管
5. **依赖 `ws` 库**：Node 生态标准选择，不自己实现协议
6. **不内置 pub/sub**：保持框架中立，连接管理由业务层（用户自管 Map 或用 Redis）

### 握手中间件链

握手阶段把 HTTP upgrade 请求当作一次普通 HTTP 请求处理，走标准洋葱模型：路由匹配 → 构造 FaapiContext → `compose(middlewares, ctx, finalHandler)`。`finalHandler` 内部完成 WS handler 加载与协议升级。

**与 HTTP 请求的差异**：
- HTTP 的 `finalHandler` 调用业务 handler 产生 Response；WS 的 `finalHandler` 加载 WS handler、绑定事件回调、调用 `wss.handleUpgrade` 完成协议升级，返回的 Response 仅作为中间件链的衔接信号
- HTTP 响应由 `sendNodeResponse` 写入 `ServerResponse`；WS 响应通过 `wss.handleUpgrade` 升级 socket，不写 HTTP 响应体

**中间件拦截语义**：
- 中间件返回 Response（如鉴权失败 401）：拦截握手，**不**进行协议升级，把 Response 写回原始 socket 后销毁连接
- 中间件 `await next()`：正常透传，握手完成、连接建立
- 中间件抛错：由 `formatErrorResponse`/内置兜底生成错误 Response，写回 socket 后销毁

**中间件塞值传递**：握手中间件塞入 ctx 的字段（如 `ctx.user`）保留在 ctx 上，WS handler 通过 `WsContext` 读取（WsContext 是 FaapiContext 的结构子集，直接复用 ctx 实例）。

**洋葱模型与协议升级时序**：
```
mw1.before → mw2.before → [finalHandler: handleUpgrade + bindEvents] → mw2.after → mw1.after
```
`handleUpgrade` 在 `finalHandler` 内同步触发 `wss.handleUpgrade` 回调（绑定事件回调），`onOpen` 在 `bindEvents` 中同步调用。中间件的 after 阶段（如日志 after）在 `onOpen` 之后执行，符合洋葱模型语义。

## WsContext 接口

```ts
interface WsContext {
  params: Record<string, string>;   // 动态路由参数
  query: URLSearchParams;            // URL 查询参数
  headers: Headers;                  // 请求头
  config: Record<string, unknown>;   // 业务配置
  // 中间件塞入的字段会被拷贝过来（如 user）
  // 可通过 declare module '@faapi/faapi' 增强
}
```

## WsHandler 接口

```ts
type WsHandler = (ctx: WsContext) => WsEventHandlers | void;

interface WsEventHandlers {
  onOpen?: (ws: WsSocket) => void;
  onMessage?: (ws: WsSocket, message: string | Buffer) => void;
  onClose?: (ws: WsSocket, code: number, reason: string) => void;
  onError?: (ws: WsSocket, error: Error) => void;
}

interface WsSocket {
  send(data: string | Buffer | object): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;  // 0=connecting, 1=open, 2=closing, 3=closed
}
```

- `WsSocket` 是 faapi 封装的 socket 抽象，对象 send 时自动 JSON.stringify
- `readyState` 与 WebSocket 规范一致

## 相关模块

- `src/router/scanRoutes.ts` - 扫描 handler.ts 时识别 `WS` 导出，生成 WS 路由记录
- `src/router/routeTypes.ts` - 新增 `WsRouteRecord` 类型
- `src/server/createServer.ts` - 监听 `server.on('upgrade')`，匹配 WS 路由并调用 handler
- `src/runtime/createContext.ts` - 握手阶段构造 WsContext
- `src/middleware/injectorTypes.ts` - WS 路由同样支持注入器
