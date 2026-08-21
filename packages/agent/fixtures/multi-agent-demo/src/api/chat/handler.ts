/**
 * Chat 路由 — 注入 agent 参数，调用 agent.run() 返回结果
 *
 * agent 参数由 @faapi/agent 插件注入（e2e 测试中手动注册工厂）。
 * 工厂未注册时 agent 为 undefined，返回 503。
 */
import type { AgentHandle } from '@faapi/agent';

export interface ChatBody {
  /** 用户输入 */
  input: string;
}

export async function POST(agent: AgentHandle | undefined, body: ChatBody) {
  if (!agent) {
    return new Response(JSON.stringify({ error: 'agent not available' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  const result = await agent.run(body.input);
  return {
    content: result.content,
    turns: result.turns,
    stopReason: result.stopReason,
  };
}
