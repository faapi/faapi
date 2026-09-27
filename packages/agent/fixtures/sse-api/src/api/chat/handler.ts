import type { AgentHandle } from '@faapi/agent';
import type { FaapiContext } from '@faapi/faapi';

/**
 * SSE 流式转发 fixture（thinking 透传 e2e 用）
 *
 * 业务方真实用法：agent.stream() 的增量经 ctx.sse() 逐帧转发给 HTTP 客户端。
 * 用于验证 thinking 推理增量（deltaReasoning）在完整 HTTP SSE 链路上逐字到达：
 * mock LLM SSE → provider 流解析 → reactLoop → Agent.stream → ctx.sse() → 客户端。
 */
export async function POST(agent: AgentHandle, ctx: FaapiContext) {
  const sse = ctx.sse();
  try {
    for await (const chunk of agent.stream(ctx.body.input, {
      agent: 'assistant',
      model: 'gpt-4o',
    })) {
      if (chunk.deltaReasoning !== undefined) {
        sse.send({ event: 'reasoning', data: chunk.deltaReasoning });
      } else if (chunk.deltaContent !== undefined) {
        sse.send({ event: 'content', data: chunk.deltaContent });
      } else if (chunk.done) {
        sse.send({ event: 'done', data: chunk.done.content ?? '' });
      }
    }
    sse.close();
  } catch (err) {
    sse.send({ event: 'error', data: String(err) });
    sse.close();
  }
}
