import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createTestServer, type TestServer } from '@faapi/faapi/testing';
import { registerAgentHandleFactory, clearAgentHandleFactory } from '@faapi/faapi';
import type { AgentCore, AgentDeps, LlmConfig } from '@faapi/faapi';
import { Agent } from './agent';
import { createOpenAIProvider } from './providers/openai';

// ─── HTTP SSE thinking 透传（e2e）────────────────────
//
// 覆盖最后一公里：mock LLM 的推理增量经真实 fetch → provider 流解析 →
// reactLoop → Agent.stream → handler 的 ctx.sse() 转发 → HTTP 客户端逐帧到达。
// 仅 LLM 端点是 mock（本地 node:http 回 OpenAI SSE），其余链路全部真实。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(__dirname, '../fixtures/sse-api');

/** mock LLM 服务器：逐字吐 reasoning_content（OpenAI SSE 线格式） */
function startMockLlm(): Promise<{ server: Server; baseURL: string }> {
  const chunks = [
    { choices: [{ delta: { reasoning_content: '深' } }] },
    { choices: [{ delta: { reasoning_content: '度' } }] },
    { choices: [{ delta: { reasoning_content: '思' } }] },
    { choices: [{ delta: { reasoning_content: '考' } }] },
    { choices: [{ delta: { content: '答案' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ];
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseURL: `http://127.0.0.1:${addr.port}/v1` });
    });
  });
}

/** SSE 帧解析：按空行分帧,取 event: / data: 行 */
function parseSseFrames(raw: string): Array<{ event?: string; data: string }> {
  return raw
    .split('\n\n')
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1] ?? '';
      return event ? { event, data } : { data };
    });
}

describe('HTTP SSE thinking 透传（e2e）', () => {
  let mockLlm: { server: Server; baseURL: string };
  let ts: TestServer;

  beforeAll(async () => {
    mockLlm = await startMockLlm();

    // 与 @faapi/agent 插件 setup 相同的真实接线：注册 handle 工厂,
    // handler 的 agent 参数经 getAgentHandle 拿到 Agent 实例
    const llmConfig: LlmConfig = {
      provider: 'openai',
      apiKey: 'sk-test',
      baseURL: mockLlm.baseURL,
      models: { 'gpt-4o': {} },
    };
    const meta: AgentCore = { name: 'assistant' };
    const deps = {
      providers: new Map([['openai', createOpenAIProvider(llmConfig)]]),
      llms: { openai: llmConfig },
      rootDir: fixtureRoot,
      getAgent: (name: string) => (name === 'assistant' ? meta : undefined),
      getAgentEntry: () => undefined,
      getTool: () => undefined,
      resolveAgentTools: () => [],
      resolveSubAgents: () => [],
      loadToolModule: async () => {
        throw new Error('not used in this fixture');
      },
      loadAgentModule: async () => {
        throw new Error('not used in this fixture');
      },
    } as unknown as AgentDeps;
    registerAgentHandleFactory(() => new Agent(deps));

    ts = await createTestServer({ rootDir: fixtureRoot });
  });

  afterAll(async () => {
    await ts.close();
    mockLlm.server.close();
    clearAgentHandleFactory();
  });

  it('reasoning 增量经 HTTP SSE 逐字到达,content 在后,拼接完整', async () => {
    const res = await fetch(`${ts.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    // 逐块读流（真实网络帧）,按 SSE 空行分帧
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const frames: Array<{ event?: string; data: string }> = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        frames.push(...parseSseFrames(buf.slice(0, idx)));
        buf = buf.slice(idx + 2);
      }
    }

    // 逐字到达：reasoning 事件按字符顺序,不合并不丢字
    const reasoning = frames.filter((f) => f.event === 'reasoning').map((f) => f.data);
    expect(reasoning).toEqual(['深', '度', '思', '考']);

    // 时序：第一个 content 帧在最后一个 reasoning 帧之后（thinking 模型输出顺序）
    const lastReasoning = frames.map((f) => f.event === 'reasoning').lastIndexOf(true);
    const firstContent = frames.findIndex((f) => f.event === 'content');
    expect(lastReasoning).toBeLessThan(firstContent);
    expect(frames.filter((f) => f.event === 'content').map((f) => f.data)).toEqual(['答案']);

    // done 收尾,消费方按到达顺序拼接得到完整推理
    expect(frames.at(-1)).toEqual({ event: 'done', data: '答案' });
    expect(reasoning.join('')).toBe('深度思考');
  });
});
