/**
 * createScriptLLM 单元测试——脚本假 LLM 的行为定义
 *
 * 详见 [scriptLlm.md](./scriptLlm.md)。
 */

import { describe, it, expect } from 'vitest';
import { createScriptLLM } from './scriptLlm';

/** 构造最小 complete 请求（仅含字段访问所需形状） */
function makeRequest(overrides?: Record<string, unknown>) {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as Parameters<typeof Object.assign>[0] extends never ? never : any;
}

describe('createScriptLLM', () => {
  it('按序回放文本回合：content + stopReason=stop', async () => {
    const llm = createScriptLLM([{ content: '第一回合' }, { content: '第二回合' }]);

    const r1 = await llm.complete(makeRequest());
    expect(r1.message.content).toBe('第一回合');
    expect(r1.stopReason).toBe('stop');
    expect(r1.message.tool_calls).toBeUndefined();

    const r2 = await llm.complete(makeRequest());
    expect(r2.message.content).toBe('第二回合');
  });

  it('toolCalls 回合：arguments 序列化为 JSON 字符串 + stopReason=tool_calls', async () => {
    const llm = createScriptLLM([
      { toolCalls: [{ name: 'weather_getWeather', arguments: { city: '北京' } }] },
    ]);

    const res = await llm.complete(makeRequest());
    expect(res.stopReason).toBe('tool_calls');
    expect(res.message.tool_calls).toHaveLength(1);
    const call = res.message.tool_calls![0]!;
    expect(call.type).toBe('function');
    expect(call.function.name).toBe('weather_getWeather');
    expect(JSON.parse(call.function.arguments)).toEqual({ city: '北京' });
  });

  it('requests 快照记录每轮完整请求', async () => {
    const llm = createScriptLLM([{ content: 'a' }, { content: 'b' }]);
    const req1 = makeRequest({ messages: [{ role: 'user', content: 'q1' }] });
    const req2 = makeRequest({ messages: [{ role: 'user', content: 'q2' }] });

    await llm.complete(req1);
    await llm.complete(req2);

    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[0]!.messages).toEqual([{ role: 'user', content: 'q1' }]);
    expect(llm.requests[1]!.messages).toEqual([{ role: 'user', content: 'q2' }]);
  });

  it('脚本用尽再被调用即抛错，且该次请求已留痕', async () => {
    const llm = createScriptLLM([{ content: '唯一回合' }]);
    await llm.complete(makeRequest());

    const overflow = makeRequest({ messages: [{ role: 'user', content: '超用' }] });
    await expect(llm.complete(overflow)).rejects.toThrow(/脚本用尽/);
    // 快照在回放前记录——超用请求可检视（第 2 轮）
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.messages).toEqual([{ role: 'user', content: '超用' }]);
  });

  it('tool call id 确定性：call_<回合序号>_<序内下标>（从 1 计）', async () => {
    const llm = createScriptLLM([
      {
        toolCalls: [
          { name: 'a', arguments: {} },
          { name: 'b', arguments: {} },
        ],
      },
      { toolCalls: [{ name: 'c', arguments: {} }] },
    ]);

    const r1 = await llm.complete(makeRequest());
    expect(r1.message.tool_calls!.map((c) => c.id)).toEqual(['call_1_0', 'call_1_1']);

    const r2 = await llm.complete(makeRequest());
    expect(r2.message.tool_calls![0]!.id).toBe('call_2_0');
  });

  it('usage 恒定占位', async () => {
    const llm = createScriptLLM([{ content: 'x' }]);
    const res = await llm.complete(makeRequest());
    expect(res.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('stream 把回合转为流式 chunk：deltaContent + finishReason=stop + usage', async () => {
    const llm = createScriptLLM([{ content: '流式文本' }]);
    const chunks = [];
    for await (const chunk of llm.stream(makeRequest())) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ deltaContent: '流式文本' });
    expect(chunks[1]).toMatchObject({ finishReason: 'stop', usage: { total_tokens: 15 } });
  });

  it('stream 的 toolCalls 回合：toolCalls chunk + finishReason=tool_calls', async () => {
    const llm = createScriptLLM([{ toolCalls: [{ name: 't', arguments: { k: 1 } }] }]);
    const chunks = [];
    for await (const chunk of llm.stream(makeRequest())) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ finishReason: 'tool_calls' });
    expect((chunks[0] as { toolCalls?: unknown[] }).toolCalls).toHaveLength(1);
  });

  it('stream 与 complete 共享同一游标（先 stream 后 complete 按序推进）', async () => {
    const llm = createScriptLLM([{ content: '回合一' }, { content: '回合二' }]);

    for await (const _ of llm.stream(makeRequest())) {
      void _;
    }
    const res = await llm.complete(makeRequest());
    expect(res.message.content).toBe('回合二');
    expect(llm.requests).toHaveLength(2);
  });

  it('空回合（无 content 无 toolCalls）：空文本 + stop', async () => {
    const llm = createScriptLLM([{}]);
    const res = await llm.complete(makeRequest());
    expect(res.message.content).toBe('');
    expect(res.stopReason).toBe('stop');
  });
});
