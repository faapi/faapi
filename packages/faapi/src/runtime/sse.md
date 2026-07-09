# SSE（Server-Sent Events）

一句话概括：让 handler 能向客户端推送流式事件，用于实时输出、LLM token 流、进度通知等场景。

## 为什么需要

faapi 现有的响应模型是一次性返回（handler return 后整体写出）。但很多场景需要持续推送数据：

- **LLM 流式输出**：agent handler 调 LLM 时，token 逐个产出，需边产生边推送，而非等全部完成
- **长任务进度**：批量处理、导入导出等耗时操作，需向客户端报告进度
- **实时通知**：订阅型接口需要持续推送事件

SSE 是 HTML5 标准的服务器推送协议，比 WebSocket 简单（单向、基于 HTTP），适合上述场景。faapi 在不破坏"函数即接口"理念的前提下，通过 `ctx.sse()` 提供 SSE 能力。

## 使用场景

### 1. LLM token 流

```ts
export async function POST(ctx) {
  const sse = ctx.sse();
  const stream = await llm.chat({ messages: [...] });
  for await (const chunk of stream) {
    sse.send({ data: chunk.text });
  }
  sse.close();
}
```

### 2. 进度通知

```ts
export async function POST(ctx) {
  const sse = ctx.sse();
  for (let i = 0; i <= 100; i += 10) {
    await doWork(i);
    sse.send({ event: 'progress', data: JSON.stringify({ percent: i }) });
  }
  sse.send({ event: 'done', data: '{}' });
  sse.close();
}
```

### 3. 上游 SSE 原始字节透传(LLM 中转平台场景)

中转 OpenAI `/v1/chat/completions` 等接口时,上游已是合法 SSE 字节流,需要逐 chunk 透传给客户端,同时边透传边解析末尾 chunk 的 `usage` 字段落库。若用 `send`,会对原文再次加 `data: ` 前缀导致双重前缀;`sendRaw` 直接写入底层流,不做任何 SSE 序列化。

> **注意**:faapi 对 POST/PUT/PATCH **始终预读请求体**(`resolveInput` 无条件调用 `request.text()`),无论 handler 是否声明 `body` 参数。因此不能再用 `ctx.request.json()`/`.text()`(会抛 "Body has already been read"),必须声明 `body` 参数获取已解析的请求体并透传。index signature 允许开放字段透传。

```ts
interface ChatBody { model?: string; stream?: boolean; [key: string]: unknown }

export async function POST(ctx, body: ChatBody) {
  const upstream = await fetch(upstreamUrl, {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });
  const sse = ctx.sse();
  let usage = null;
  try {
    for await (const chunk of upstream.body as ReadableStream<Uint8Array>) {
      if (sse.aborted) break;
      sse.sendRaw(chunk);                 // 逐字节透传,不重新序列化
      usage = captureUsage(chunk, usage); // 边透传边解析 usage
    }
  } finally {
    await insertCallLog({ usage });
    sse.close();
  }
}
```

> `sendRaw` 不校验内容是否合法 SSE 格式,调用方需保证透传的内容符合 [HTML5 SSE 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html)。

### 4. 命名事件 + 自定义状态码

```ts
export function POST(ctx) {
  ctx.setStatus(201);
  const sse = ctx.sse();
  sse.send({ event: 'created', data: 'ok' });
  sse.close();
}
```

## 设计要点

### ctx.sse() 的返回值

`ctx.sse()` 返回一个 `SseWriter` 对象，**不直接返回 Response**。handler 调用 `sse.send()` 推送事件，调用 `sse.close()` 结束流。框架在 handler 返回后，识别到 ctx 持有活跃的 SSE writer，自动构造 `text/event-stream` Response。

这种设计的好处：
- handler 可以"边写边等"（异步推送），符合"函数即接口"的直观风格
- 不需要用户手动构造 ReadableStream 和 encoder
- writer 的生命周期由框架管理，避免忘记关闭流

### SseWriter 接口

| 成员 | 类型 | 说明 |
|------|------|------|
| `send(event)` | 方法 | 推送一个 SSE 事件（`{ data, event?, id?, retry? }`） |
| `sendRaw(chunk)` | 方法 | 直接写入原始字节/字符串,不做 SSE 序列化（用于透传上游 SSE 原文） |
| `sendError(message)` | 方法 | 推送 `event: error` 事件并关闭流（异常分支用） |
| `close()` | 方法 | 关闭流（重复调用幂等） |
| `aborted` | 只读属性 | 客户端断开时变 `true`,底层监听 ReadableStream cancel 信号 |
| `closed` | 只读属性 | 流已关闭时为 `true` |
| `response` | 只读属性 | 框架构造的 `Response` 对象（handler 返回后由框架读取） |

#### `send` vs `sendRaw` 的职责分工

| 方法 | 输入 | 行为 | 适用场景 |
|------|------|------|---------|
| `send(event)` | 结构化 `SseEvent` 对象 | 调用 `encodeSseEvent` 序列化为合法 SSE 文本 | 自产生事件（LLM token、进度、通知） |
| `sendRaw(chunk)` | `string \| Uint8Array` 原始字节 | 直接 enqueue 到底层流,不做任何处理 | 透传上游已有的 SSE 原文 |

`sendRaw` 不校验内容是否合法 SSE,调用方负责格式正确性。两者可混用(如先 `send` 推送自定义事件,再 `sendRaw` 透传上游流)。

### 客户端断开检测（aborted）

`SseWriter` 提供 `aborted` 只读属性，客户端断开连接时变为 `true`。底层通过监听 ReadableStream 的 `cancel` 信号实现。

```ts
export async function POST(ctx) {
  const sse = ctx.sse();
  while (!sse.aborted) {
    sse.send({ data: 'tick' });
    await new Promise((r) => setTimeout(r, 1000));
  }
  // 客户端断开后退出循环，无需手动 close（框架兜底）
}
```

aborted 为 true 后，`send()` 静默忽略（不抛错），便于 handler 在循环中继续调用 send 而无需 try/catch。

### 自动 close（框架兜底）

handler 返回后，框架检查 ctx 是否持有未关闭的 SSE writer，若有则**自动调用 close()**。这是兜底机制，避免 handler 忘记 close 导致连接泄漏。

```ts
export async function POST(ctx) {
  const sse = ctx.sse();
  sse.send({ data: 'hello' });
  // 忘记 sse.close() 也没关系，框架会兜底
}
```

**推荐写法**：仍然显式调用 `sse.close()`，让 handler 的结束时机明确；自动 close 用于异常分支和遗漏场景。

### SSE 事件格式

遵循 [HTML5 SSE 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html)，每个事件由若干字段行组成，以空行结束：

```
event: <event-name>\n
data: <data>\n
id: <id>\n
retry: <ms>\n
\n
```

`data` 若是多行字符串，每行都加 `data: ` 前缀。

### 与现有机制的关系

| 机制 | 与 SSE 的关系 |
|------|--------------|
| `ctx.setStatus / setHeader` | 生效：合并到 SSE Response 的 headers（status 默认 200） |
| 全局错误中间件 | 流开始前报错可被中间件 `try/catch` 拦截；流开始后报错由框架向流写入 error 事件后关闭 |
| 中间件洋葱模型 | 中间件返回 Response 时，若 handler 已用 ctx.sse()，handler 返回的值被忽略（SSE 优先） |
| `ctx.json / ctx.html` | 与 ctx.sse 互斥：一个 handler 只能用一种响应方式 |

### 错误处理

- **流开始前**（handler 同步抛错或返回前异常）：走错误兜底链（全局错误中间件 → formatErrorResponse → 500）
- **流开始后**（已调用 sse.send）：向流写入 `event: error\ndata: <message>\n\n`，然后关闭流。客户端收到 error 事件后自行处理

### 客户端断开

客户端断开连接时，`sse.aborted` 变为 true，`sse.send()` 静默忽略。handler 可通过 `sse.aborted` 退出循环；若 handler 未退出，框架在 handler 返回后自动 close。

无需 try/finally 强制 close，框架兜底保证不泄漏连接。

## 相关模块

- [createContext](./createContext.md)：挂载 `ctx.sse()` 方法
- [contextTypes](./contextTypes.md)：`FaapiContext` 接口包含 `sse()` 方法签名
- [toResponse](../response/toResponse.md)：识别 ctx 持有的 SSE writer，构造 `text/event-stream` Response
- [invokeHandler](./invokeHandler.md)：handler 返回后，invokeHandler 把 ctx 传给 toResponse
- [createServer](../server/createServer.md)：SSE Response 不被中间件包装
