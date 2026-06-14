# 场景:实时通信(WebSocket / SSE)

## 何时加载

用户要写 WebSocket、SSE、流式响应、长连接,或实时通信相关问题。

## SSE vs WebSocket

| 特性 | SSE | WebSocket |
|------|-----|-----------|
| 方向 | 单向(服务端→客户端) | 双向 |
| 协议 | HTTP | WS |
| 适用 | LLM 流式输出、通知 | 聊天室、协同编辑 |
| API | `ctx.sse()` | `WS` 导出 |
| 中间件 | 走标准洋葱 | 握手走洋葱,事件回调不走 |

## SSE — 流式响应

### 基本用法

```ts
// api/stream/handler.ts
export function GET(ctx) {
  const sse = ctx.sse();

  // 推送事件
  sse.send({ data: 'chunk1' });
  sse.send({ data: 'chunk2', event: 'progress' });

  // 关闭流
  setTimeout(() => sse.close(), 1000);

  return;  // 不返回普通值,SSE 与 ctx.json/html 互斥
}
```

### SseWriter API

| 方法/属性 | 说明 |
|----------|------|
| `send({ data, event?, id?, retry? })` | 推送事件 |
| `close()` | 关闭流 |
| `aborted` | 客户端是否断开 |

```ts
sse.send({ data: 'message' });
sse.send({ data: 'update', event: 'progress', id: '1', retry: 5000 });
```

### LLM 流式输出示例

```ts
// api/chat/handler.ts
export async function POST(ctx, body: { prompt: string }) {
  const sse = ctx.sse();

  const stream = await callLLM(body.prompt);
  for await (const chunk of stream) {
    if (sse.aborted) break;  // 客户端断开
    sse.send({ data: chunk });
  }

  sse.close();
}
```

### SSE 行为

- 框架自动构造 `text/event-stream` Response
- `responseFormat` **不包装** SSE 响应
- `SseWriter.aborted` 检测客户端断开
- handler 返回或抛错时框架自动 `close` 兜底,避免连接泄漏
- SSE 与 `ctx.json`/`ctx.html` 互斥(handler 只能返回一个)

## WebSocket — 双向长连接

### 基本用法

```ts
// api/chat/handler.ts
import type { WsContext, WsEventHandlers } from '@faapi/faapi';

export function WS(ctx: WsContext): WsEventHandlers {
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

### WsContext

握手阶段构造:

| 属性 | 说明 |
|------|------|
| `ctx.params` | 动态路由参数 |
| `ctx.query` | URL 查询参数 |
| `ctx.headers` | 请求头 |
| `ctx.config` | 业务配置 |

可用 `declare module` 增强:

```ts
declare module '@faapi/faapi' {
  interface WsContext {
    user?: { id: number };
  }
}
```

### WsSocket

faapi 封装 socket 抽象,不暴露 ws 库原生 socket:

| 方法/属性 | 说明 |
|----------|------|
| `send(data)` | string/Buffer 直发,对象自动 JSON.stringify |
| `close(code?, reason?)` | 关闭连接 |
| `readyState` | 0=connecting, 1=open, 2=closing, 3=closed |

```ts
onMessage(ws, message) {
  ws.send({ echo: message });  // 对象自动 JSON.stringify
}
```

### 事件回调

`onOpen`/`onMessage`/`onClose`/`onError` 均可选,未提供则忽略。

连接建立后切到事件模型,**不走洋葱中间件**。

## WebSocket 路由匹配

WS 路由**无 HTTP 方法维度**,按 URL pathname 匹配:

```
api/chat/handler.ts          → ws://host/api/chat
api/chat/[id]/handler.ts     → ws://host/api/chat/123
api/chat/[...slug]/handler.ts → ws://host/api/chat/anything
```

- 动态路由 `[id]`、catch-all `[...slug]`、分组 `(name)` 同样适用
- 未匹配路径返回 404 并销毁 socket

## WebSocket 握手中间件

握手阶段(HTTP upgrade)**复用洋葱中间件链**,与同目录 HTTP 路由共享鉴权/CORS/限流:

```ts
// api/chat/middlewares.ts
import type { FaapiMiddleware } from '@faapi/faapi';

export default [
  async (ctx, next) => {
    const token = ctx.headers.get('authorization');
    if (!token) {
      return new Response('Unauthorized', { status: 401 });
    }
    ctx.user = await verifyToken(token);
    await next();
  },
] satisfies FaapiMiddleware[];
```

WS 路由的握手阶段会跑这个中间件。**连接建立后**(onOpen 触发)切到事件模型,后续 onMessage/onClose 不走中间件。

## 两阶段中间件策略

```
握手阶段(HTTP upgrade)
  ↓
  跑洋葱中间件(鉴权/CORS/限流)
  ↓
  连接建立 → onOpen
  ↓
事件回调阶段(不走中间件)
  ↓
  onMessage / onClose / onError
```

**设计理由**:握手是 HTTP 请求,可走标准中间件链;连接建立后是长连接事件,频繁跑中间件无意义且影响性能。

## 完整示例:聊天室

```ts
// api/chat/[room]/handler.ts
import type { WsContext, WsEventHandlers, WsSocket } from '@faapi/faapi';

const rooms = new Map<string, Set<WsSocket>>();

export function WS(ctx: WsContext): WsEventHandlers {
  const roomId = ctx.params.room;
  const user = ctx.user!;  // 中间件塞的

  return {
    onOpen(ws) {
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId)!.add(ws);
      ws.send(`Welcome to room ${roomId}`);
    },
    onMessage(ws, message) {
      // 广播到房间
      for (const client of rooms.get(roomId)!) {
        if (client.readyState === 1) {
          client.send({ user: user.name, message });
        }
      }
    },
    onClose(ws) {
      rooms.get(roomId)?.delete(ws);
    },
  };
}
```

```ts
// api/chat/[room]/middlewares.ts
import type { FaapiMiddleware, InjectorMap } from '@faapi/faapi';

export default [
  async (ctx, next) => {
    const token = ctx.headers.get('sec-websocket-protocol');
    if (!token) return new Response('Unauthorized', { status: 401 });
    ctx.user = await verifyToken(token);
    await next();
  },
] satisfies FaapiMiddleware[];

export const injectors: InjectorMap = {
  user: (ctx) => ctx.user,
};
```

## 常见坑点

### 1. SSE 返回值互斥

```ts
// ❌ 返回 SSE 后又返回普通值
export function GET(ctx) {
  const sse = ctx.sse();
  sse.send({ data: 'hello' });
  return { ok: true };  // 冲突
}

// ✅ SSE 后不返回普通值
export function GET(ctx) {
  const sse = ctx.sse();
  sse.send({ data: 'hello' });
  setTimeout(() => sse.close(), 1000);
  return;
}
```

### 2. WebSocket 忘记 close

```ts
// ❌ 不 close,连接泄漏
onOpen(ws) {
  ws.send('hello');
  // 没 close,客户端等待
}

// ✅ 明确 close 或依赖框架兜底
onOpen(ws) {
  ws.send('hello');
  ws.close();
}
```

handler 返回或抛错时框架自动 close 兜底,但建议明确管理生命周期。

### 3. WS 路由用 GET 导出

```ts
// ❌ WS 路由不需要导出 GET
export function GET() { ... }
export function WS(ctx) { ... }

// ✅ 只导出 WS
export function WS(ctx) { ... }
```

WS 路由无 HTTP 方法维度,只导出 `WS` 函数。如果同文件也导出 GET,会同时注册 HTTP GET 路由。

### 4. SSE 不检查 aborted

```ts
// ❌ 客户端断开后还在 send
export async function GET(ctx) {
  const sse = ctx.sse();
  while (true) {
    sse.send({ data: 'tick' });
    await sleep(1000);
  }
}

// ✅ 检查 aborted
export async function GET(ctx) {
  const sse = ctx.sse();
  while (!sse.aborted) {
    sse.send({ data: 'tick' });
    await sleep(1000);
  }
  sse.close();
}
```

## 检查清单

### SSE
- [ ] 用 `ctx.sse()` 创建 writer
- [ ] 循环中检查 `sse.aborted`
- [ ] 明确 `sse.close()` 或依赖框架兜底
- [ ] 不与 `ctx.json`/`ctx.html` 混用

### WebSocket
- [ ] 导出 `WS` 函数(不是 GET/POST)
- [ ] 返回 `WsEventHandlers` 对象
- [ ] 握手中间件放在同目录 `middlewares.ts`
- [ ] 不在事件回调中依赖中间件
- [ ] `readyState === 1` 才 send

## 相关场景

- [middleware.md](./middleware.md) — 握手中间件
- [route.md](./route.md) — 路由文件约定
- [config.md](./config.md) — ctx.config 在 WS 中可用
