import type { FaapiContext } from '@faapi/faapi';

/**
 * SSE 流中抛错测试 fixture
 *
 * 首次写入（响应头已发出）后抛错：已推送事件应照常送达、连接以流终止收尾，
 * 不能再改发 500 错误响应。
 */
export async function GET(ctx: FaapiContext) {
  const sse = ctx.sse();
  sse.send({ data: 'before-error' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  throw new Error('mid-stream');
}
