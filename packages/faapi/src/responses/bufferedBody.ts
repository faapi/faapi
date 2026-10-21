/**
 * 缓冲型 body 的 Response 标记（side-channel，与 pendingMeta 同一模式）
 *
 * `new Response(string | Buffer | Uint8Array)` 的 body 是**有限内存型**——发送层
 * 可整体读出后 `res.end` 直写，免去 `Readable.fromWeb + pipe` 的全套流机器（每响应
 * 数个中间流对象，JSON 响应的常态路径）。活跃流（SSE、handler 自建 ReadableStream）
 * 不能这样读——整体缓冲会破坏流式语义并可能永久挂起，但仅凭 Response 对象无法区分
 * 两种形态，因此在构造点标记。
 *
 * WeakSet：Response 被丢弃后标记自动可 GC，无手动清理。
 */
const bufferedBodyResponses = new WeakSet<Response>();

/** 标记一个 body 为有限内存型（构造点调用；Response 已带标记时重复调用安全） */
export function markBufferedBody(response: Response): void {
  bufferedBodyResponses.add(response);
}

/** 查询 Response 是否带缓冲型 body 标记（发送层快路径判定用） */
export function hasBufferedBody(response: Response): boolean {
  return bufferedBodyResponses.has(response);
}
