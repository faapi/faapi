---
'@faapi/faapi': minor
---

`SseWriter` 新增 `sendRaw(chunk)` 方法,支持原始字节/字符串透传(不做 SSE 序列化)。

## 背景

LLM 中转平台场景(如转发 OpenAI `/v1/chat/completions`)需要逐 chunk 透传上游已有的 SSE 原文,同时边透传边解析末尾 chunk 的 `usage` 字段落库。现有 `send(event)` 会调用 `encodeSseEvent` 再次加 `data: ` 前缀,导致双重前缀,无法用于原文透传。

## 变更

`SseWriter` interface 新增方法:

```ts
sendRaw(chunk: string | Uint8Array): void;
```

- 直接 enqueue 到底层 ReadableStream,不做任何 SSE 序列化
- 接受 `string` 或 `Uint8Array`(Buffer 是子类,自然兼容)
- 与 `send` 同守卫:`close`/`aborted` 后静默忽略,不抛错
- 不校验内容是否合法 SSE,调用方负责格式正确性
- 与 `send` 可混用(如先 `send` 推自定义事件,再 `sendRaw` 透传上游流)

## 用法

```ts
interface ChatBody { model?: string; stream?: boolean; [key: string]: unknown }

export async function POST(ctx, body: ChatBody) {
  const upstream = await fetch(upstreamUrl, { method: 'POST', body: JSON.stringify(body) });
  const sse = ctx.sse();
  let usage = null;
  try {
    for await (const chunk of upstream.body as ReadableStream<Uint8Array>) {
      if (sse.aborted) break;
      sse.sendRaw(chunk);                  // 逐字节透传,不重新序列化
      usage = captureUsage(chunk, usage);  // 边透传边解析 usage
    }
  } finally {
    await insertCallLog({ usage });
    sse.close();
  }
}
```

> faapi 对 POST/PUT/PATCH 始终预读请求体,必须声明 `body` 参数获取已解析对象,不能用 `ctx.request.json()`/`.text()`(会抛 "Body has already been read")。

## `send` vs `sendRaw`

| 方法 | 输入 | 行为 | 适用场景 |
|------|------|------|---------|
| `send(event)` | 结构化 `SseEvent` 对象 | 调用 `encodeSseEvent` 序列化 | 自产生事件(LLM token、进度、通知) |
| `sendRaw(chunk)` | `string \| Uint8Array` 原始字节 | 直接写入底层流,不做处理 | 透传上游已有的 SSE 原文 |
