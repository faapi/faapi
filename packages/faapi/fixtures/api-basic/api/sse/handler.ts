import type { FaapiContext } from '@faapi/faapi';

/**
 * SSE 流式响应测试 fixture
 *
 * 通过 ctx.sse() 推送多个事件后关闭，用于验证：
 * - Content-Type 为 text/event-stream
 * - 事件按发送顺序到达
 * - SSE 响应不被中间件包装
 */
export function GET(ctx: FaapiContext) {
  const sse = ctx.sse();
  sse.send({ data: 'first' });
  sse.send({ event: 'progress', data: '50' });
  sse.send({ event: 'done', data: '100' });
  sse.close();
}
