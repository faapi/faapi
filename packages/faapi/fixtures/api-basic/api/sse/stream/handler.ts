import type { FaapiContext } from '@faapi/faapi';

/**
 * SSE 流式时机测试 fixture
 *
 * 每 100ms 推送一个事件共 4 个，供 e2e 断言字节随推送节奏散开到达
 * （而非 handler 结束后一次性到达），验证「首次写入即接管」的流式语义。
 */
export async function GET(ctx: FaapiContext) {
  const sse = ctx.sse();
  for (let i = 1; i <= 4; i++) {
    sse.send({ data: `chunk-${i}` });
    if (i < 4) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  sse.close();
}
