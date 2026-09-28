/**
 * SSE（Server-Sent Events）支持
 *
 * 让 handler 能向客户端推送流式事件，用于 LLM token 流、进度通知等场景。
 *
 * 核心导出：
 * - `encodeSseEvent(event)`：把 SSE 事件对象编码为符合 HTML5 SSE 规范的字符串
 * - `createSseWriter()`：创建一个 SseWriter，封装 ReadableStream + Response，提供 send/close/onClose/sendError API
 * - `SseWriter`：writer 类型，ctx.sse() 返回此类型
 *
 * 设计要点：
 * - writer 内部用 ReadableStream + TextEncoder，send 时 enqueue，close 时 close controller
 * - response 预设 text/event-stream、no-cache、keep-alive、X-Accel-Buffering: no 头，状态码默认 200
 *   （X-Accel-Buffering: no 让 nginx 按响应跳过 proxy_buffering，SSE 小包不被攒到流结束才下发；
 *   非 nginx 反代不识别该头，当普通自定义头透传）
 * - close 后再 send 静默忽略，避免 handler 异步流程中误写已关闭的流
 * - sendError 向流写入 event: error 后关闭，用于流式输出中报错的优雅终止
 * - 背压：send/sendRaw 保持同步；desiredSize 暴露缓冲状态，waitForDrain() 供
 *   生产循环在缓冲超水位时暂停（pull 钩子唤醒），防慢客户端内存无界增长
 *
 * 与 ctx 的集成：
 * - ctx.sse() 调用 createSseWriter()，并把 response 缓存到 ctx 内部字段
 * - 首次写入（send/sendRaw/sendError）经 onFirstWrite 触发 server 层提前接管钩子，
 *   响应立即接入底层连接（流式即产即达）；无钩子场景回落为 handler 返回后由
 *   invokeHandler 检查 ctx 持有的 SSE response，有则优先使用
 */

import { stringifyJson } from '../utils/stringifyJson';

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

  // data：对象 JSON.stringify（BigInt 安全，见 utils/stringifyJson），多行每行加前缀
  if (event.data !== undefined) {
    let dataStr: string;
    if (typeof event.data === 'string') {
      dataStr = event.data;
    } else if (event.data === null) {
      dataStr = 'null';
    } else {
      dataStr = stringifyJson(event.data);
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
 * ctx.sse() 的选项
 */
export interface SseOptions {
  /**
   * 声明流生命周期独立于 handler 返回（长连接订阅模式）
   *
   * `true` 时 handler 返回后框架不自动 close——handler 只负责把连接挂到推送源
   * （事件总线、change stream），注册完立即返回，连接长存直到显式 close()、
   * 客户端断开或 handler 抛错兜底。清理推送源用 `onClose(callback)`。
   * 默认 false（handler 返回时框架自动 close 兜底）。
   */
  keepOpen?: boolean;
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
  /**
   * 直接写入原始字节/字符串,不做任何 SSE 序列化
   *
   * 用于透传上游已有的 SSE 原文(如 LLM 中转平台逐 chunk 转发 OpenAI 响应)。
   * 调用方负责保证内容符合 HTML5 SSE 规范;`send` 会再次加 `data: ` 前缀,
   * 不适用于原文透传场景。
   *
   * 接受 string 或 Uint8Array(Buffer 是 Uint8Array 子类,自然兼容)。
   * 与 `send` 一致:close/aborted 后静默忽略,不抛错。
   */
  sendRaw(chunk: string | Uint8Array): void;
  /** 推送一个 error 事件并关闭流（用于流式输出中报错的优雅终止） */
  sendError(error: unknown): void;
  /** 关闭流（多次调用安全） */
  close(): void;
  /**
   * 注册流结束回调
   *
   * 显式 close、框架兜底 close、客户端断开、sendError 任一路径结束流时恰好触发
   * 一次（多个回调按注册顺序执行，回调自身抛错被忽略）；注册时流已结束则立即触发。
   * keepOpen 模式下用于退订/清理推送源，防止客户端断开后订阅随重连累积泄漏。
   */
  onClose(callback: () => void): void;
  /** 流是否已关闭（handler 主动 close 或框架自动 close） */
  readonly closed: boolean;
  /** 客户端是否已断开（ReadableStream 被 cancel） */
  readonly aborted: boolean;
  /** 创建时是否声明了 `{ keepOpen: true }`（handler 返回后框架不自动 close） */
  readonly keepOpen: boolean;
  /**
   * 流缓冲背压状态（透传 controller.desiredSize）
   *
   * `null` = 流已关闭/断开；`<= 0` 表示消费慢于生产（缓冲超过高水位），生产循环
   * 应 `await waitForDrain()` 暂停，否则快生产者（LLM token 流）+ 慢客户端会让
   * 缓冲无界增长。`send`/`sendRaw` 保持同步不抛，背压响应由调用方自决。
   */
  readonly desiredSize: number | null;
  /**
   * 等待流缓冲排空（背压感知）
   *
   * 缓冲低于高水位（desiredSize > 0）时立即返回；否则挂起直到消费者拉取使缓冲
   * 排空（ReadableStream pull 钩子唤醒）、或流关闭/客户端断开（避免悬挂）。
   * 典型用法见 runtime/sse.md「背压」章节。
   */
  waitForDrain(): Promise<void>;
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
 *
 * onFirstWrite：首次成功写入（send/sendRaw/sendError）时以 response 调用一次。
 * HTTP 服务场景由 ctx.sse() 接到 server 层的提前接管钩子——首次写入即把响应
 * 接入底层连接，流式期间字节即产即达（见 createServer.md「SSE 提前接管」）。
 *
 * keepOpen：声明后 writer.keepOpen 为 true，invokeHandler 在 handler 正常返回时
 * 跳过自动 close（长连接订阅模式）；handler 抛错路径的兜底 close 不受影响。
 */
export function createSseWriter(
  options: SseOptions & { onFirstWrite?: (response: Response) => void } = {},
): SseWriter {
  const { onFirstWrite, keepOpen = false } = options;
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let aborted = false;
  /** 首次写入回调是否已触发（幂等：多次写入只触发一次） */
  let firstWriteTriggered = false;
  /** waitForDrain 挂起中的等待方——消费者拉取（pull）/关闭/断开时唤醒 */
  let drainWaiters: Array<() => void> = [];
  /** onClose 注册的结束回调——任一路径结束流时逐个执行一次 */
  let closeCallbacks: Array<() => void> = [];
  /** 结束回调是否已执行（保证恰好一次：close/cancel 幂等路径不重复触发） */
  let closeCallbacksFired = false;

  const safeRunCallback = (callback: () => void): void => {
    try {
      callback();
    } catch {
      // 回调自身抛错不影响流收尾与其他回调（与 onError 钩子「自身抛错被忽略」同约定）
    }
  };

  const runCloseCallbacks = (): void => {
    if (closeCallbacksFired) return;
    closeCallbacksFired = true;
    const callbacks = closeCallbacks;
    closeCallbacks = [];
    for (const callback of callbacks) safeRunCallback(callback);
  };

  const resolveDrainWaiters = (): void => {
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve();
  };

  // 首次成功 enqueue 后触发（幂等）。放在 enqueue 之后：接管开始消费时首个
  // chunk 已在流中，字节顺序不因接管时机改变
  const triggerFirstWrite = (): void => {
    if (firstWriteTriggered) return;
    firstWriteTriggered = true;
    onFirstWrite?.(response);
  };

  // 高水位 16 个 chunk（SSE chunk 小）：给消费者留缓冲余量，超过即 desiredSize <= 0，
  // 生产方可感知背压。无显式策略时默认 HWM=1,waitForDrain 过于激进
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      // 消费者排空缓冲后再要数据 → 背压解除，唤醒 waitForDrain 等待方
      pull() {
        resolveDrainWaiters();
      },
      cancel() {
        // 客户端断开连接（cancel ReadableStream）
        aborted = true;
        closed = true;
        controller = null;
        // 结束回调与等待方立即放行（清理出口 + 生产循环靠 aborted 退出）
        runCloseCallbacks();
        resolveDrainWaiters();
      },
    },
    { highWaterMark: 16 },
  );

  const response = new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // nginx 认到该头后按响应跳过 proxy_buffering；其他反代/客户端忽略，无副作用
      'X-Accel-Buffering': 'no',
    },
  });

  const writer: SseWriter = {
    send(event: SseEvent): void {
      if (closed || !controller) return;
      const text = encodeSseEvent(event);
      controller.enqueue(encoder.encode(text));
      triggerFirstWrite();
    },

    sendRaw(chunk: string | Uint8Array): void {
      if (closed || !controller) return;
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
      controller.enqueue(bytes);
      triggerFirstWrite();
    },

    sendError(error: unknown): void {
      if (closed || !controller) return;
      const message = error instanceof Error ? error.message : String(error);
      const text = encodeSseEvent({ event: 'error', data: message });
      try {
        controller.enqueue(encoder.encode(text));
        triggerFirstWrite();
      } finally {
        writer.close();
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      // 结束回调先于 controller.close：清理出口（退订/清定时器）在流收尾前执行
      runCloseCallbacks();
      // 关闭唤醒全部等待方（resolved 的 Promise 不会让生产循环悬挂）
      resolveDrainWaiters();
      if (controller) {
        try {
          controller.close();
        } catch {
          // controller 可能已关闭，忽略
        }
        controller = null;
      }
    },

    onClose(callback: () => void): void {
      // 流已结束（含 cancel 置位的 aborted 路径）：立即触发，保证恰好一次语义
      if (closeCallbacksFired) {
        safeRunCallback(callback);
        return;
      }
      closeCallbacks.push(callback);
    },

    get closed(): boolean {
      return closed;
    },

    get desiredSize(): number | null {
      return controller ? controller.desiredSize : null;
    },

    waitForDrain(): Promise<void> {
      // 已关闭/断开：立即返回（生产循环自行感知 closed/aborted 退出）
      if (closed || !controller) return Promise.resolve();
      // 缓冲低于高水位：背压未触发，立即返回
      if ((controller.desiredSize ?? 0) > 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },

    get aborted(): boolean {
      return aborted;
    },

    get keepOpen(): boolean {
      return keepOpen;
    },

    get response(): Response {
      return response;
    },
  };

  return writer;
}
