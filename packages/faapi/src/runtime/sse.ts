/**
 * SSE（Server-Sent Events）支持
 *
 * 让 handler 能向客户端推送流式事件，用于 LLM token 流、进度通知等场景。
 *
 * 核心导出：
 * - `encodeSseEvent(event)`：把 SSE 事件对象编码为符合 HTML5 SSE 规范的字符串
 * - `createSseWriter()`：创建一个 SseWriter，封装 ReadableStream + Response，提供 send/close/sendError API
 * - `SseWriter`：writer 类型，ctx.sse() 返回此类型
 *
 * 设计要点：
 * - writer 内部用 ReadableStream + TextEncoder，send 时 enqueue，close 时 close controller
 * - response 预设 text/event-stream、no-cache、keep-alive 头，状态码默认 200
 * - close 后再 send 静默忽略，避免 handler 异步流程中误写已关闭的流
 * - sendError 向流写入 event: error 后关闭，用于流式输出中报错的优雅终止
 *
 * 与 ctx 的集成：
 * - ctx.sse() 调用 createSseWriter()，并把 response 缓存到 ctx 内部字段
 * - invokeHandler 在 handler 返回后检查 ctx 是否持有 SSE response，有则优先使用
 */

/**
 * SSE 事件字段
 *
 * 遵循 HTML5 SSE 规范：
 * - `data`：消息数据，多行时每行加 `data: ` 前缀；对象自动 JSON.stringify
 * - `event`：事件类型，客户端可用 addEventListener(event) 监听
 * - `id`：事件 ID，客户端断线重连时通过 Last-Event-ID 头发送
 * - `retry`：重连等待时间（毫秒）
 * - `comment`：注释行（以 `:` 开头），用于 keep-alive 心跳，不传递给客户端消息
 */
export interface SseEvent {
  /** 消息数据。字符串原样输出；对象自动 JSON.stringify；多行时每行加 data: 前缀 */
  data?: unknown;
  /** 事件类型，客户端可用 addEventListener 监听 */
  event?: string;
  /** 事件 ID，客户端断线重连时通过 Last-Event-ID 头发送 */
  id?: string | number;
  /** 重连等待时间（毫秒） */
  retry?: number;
  /** 注释行（以 : 开头），用于 keep-alive 心跳 */
  comment?: string;
}

/**
 * 把 SSE 事件对象编码为符合 HTML5 SSE 规范的字符串
 *
 * 字段顺序固定：comment > event > id > retry > data，末尾空行分隔事件。
 *
 * @param event SSE 事件对象
 * @returns 编码后的字符串（含末尾空行）
 */
export function encodeSseEvent(event: SseEvent): string {
  let out = '';

  // comment（注释行，以 : 开头）
  if (event.comment !== undefined) {
    out += `: ${event.comment}\n`;
  }

  // event
  if (event.event !== undefined) {
    out += `event: ${event.event}\n`;
  }

  // id
  if (event.id !== undefined) {
    out += `id: ${event.id}\n`;
  }

  // retry
  if (event.retry !== undefined) {
    out += `retry: ${event.retry}\n`;
  }

  // data：对象 JSON.stringify，多行每行加前缀
  if (event.data !== undefined) {
    let dataStr: string;
    if (typeof event.data === 'string') {
      dataStr = event.data;
    } else if (event.data === null) {
      dataStr = 'null';
    } else {
      dataStr = JSON.stringify(event.data);
    }
    // 多行 data：每行加 data: 前缀
    const lines = dataStr.split('\n');
    for (const line of lines) {
      out += `data: ${line}\n`;
    }
  }

  // 空行结束事件
  out += '\n';
  return out;
}

/**
 * SSE writer：封装流式推送 API
 *
 * 通过 `ctx.sse()` 创建，handler 调用 `send` 推送事件，`close` 关闭流。
 * 框架在 handler 返回后，自动使用 writer.response 作为 HTTP 响应。
 */
export interface SseWriter {
  /** 推送一个 SSE 事件 */
  send(event: SseEvent): void;
  /** 推送一个 error 事件并关闭流（用于流式输出中报错的优雅终止） */
  sendError(error: unknown): void;
  /** 关闭流（多次调用安全） */
  close(): void;
  /** 流是否已关闭（handler 主动 close 或框架自动 close） */
  readonly closed: boolean;
  /** 客户端是否已断开（ReadableStream 被 cancel） */
  readonly aborted: boolean;
  /** 对应的 HTTP Response（由框架使用，用户一般不需要直接访问） */
  readonly response: Response;
}

/**
 * 创建一个 SSE writer
 *
 * 内部用 ReadableStream + TextEncoder 实现，send 时把编码后的事件 enqueue 到流，
 * close 时关闭 controller。response 预设标准 SSE 头。
 *
 * aborted 检测：监听 ReadableStream 的 cancel 钩子，客户端断开（cancel）时置为 true。
 * 此时 send 静默忽略，handler 可通过 writer.aborted 退出循环。
 */
export function createSseWriter(): SseWriter {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let aborted = false;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // 客户端断开连接（cancel ReadableStream）
      aborted = true;
      closed = true;
      controller = null;
    },
  });

  const response = new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });

  const writer: SseWriter = {
    send(event: SseEvent): void {
      if (closed || !controller) return;
      const text = encodeSseEvent(event);
      controller.enqueue(encoder.encode(text));
    },

    sendError(error: unknown): void {
      if (closed || !controller) return;
      const message = error instanceof Error ? error.message : String(error);
      const text = encodeSseEvent({ event: 'error', data: message });
      try {
        controller.enqueue(encoder.encode(text));
      } finally {
        writer.close();
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      if (controller) {
        try {
          controller.close();
        } catch {
          // controller 可能已关闭，忽略
        }
        controller = null;
      }
    },

    get closed(): boolean {
      return closed;
    },

    get aborted(): boolean {
      return aborted;
    },

    get response(): Response {
      return response;
    },
  };

  return writer;
}
