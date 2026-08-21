import { describe, it, expect, vi } from 'vitest';
import { reactLoop, reactLoopStream, ReactLoopError } from './reactLoop';
import type {
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  LLMMessage,
  LLMUsage,
  LLMStopReason,
} from './provider';

// ─── Mock 工具 ──────────────────────────────────────

/** 构造 LLMResponse（complete 模式） */
function llmResponse(opts: {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason?: LLMStopReason;
  usage?: LLMUsage;
}): LLMResponse {
  const message: LLMMessage = {
    role: 'assistant',
    content: opts.content ?? '',
  };
  if (opts.toolCalls && opts.toolCalls.length > 0) {
    message.toolCalls = opts.toolCalls;
  }
  return {
    message,
    stopReason: opts.stopReason ?? (opts.toolCalls ? 'tool_calls' : 'stop'),
    usage: opts.usage,
  };
}

/** 创建 mock LLMProvider（complete 按序列返回） */
function createMockProvider(responses: LLMResponse[]): {
  provider: LLMProvider;
  completeCalls: ReturnType<typeof vi.fn>;
} {
  const completeCalls = vi.fn();
  let callIndex = 0;
  const provider: LLMProvider = {
    complete: async (request) => {
      completeCalls(request);
      const res = responses[callIndex++];
      if (!res) throw new Error('No more mock responses');
      return res;
    },
    stream: () => {
      throw new Error('stream not mocked');
    },
  };
  return { provider, completeCalls };
}

/** 创建 mock streaming LLMProvider */
function createMockStreamProvider(turnChunks: LLMStreamChunk[][]): {
  provider: LLMProvider;
  streamCalls: ReturnType<typeof vi.fn>;
} {
  const streamCalls = vi.fn();
  let turnIndex = 0;
  const provider: LLMProvider = {
    complete: async () => {
      throw new Error('complete not mocked');
    },
    stream: async function* (request) {
      streamCalls(request);
      const chunks = turnChunks[turnIndex++];
      if (!chunks) throw new Error('No more mock stream turns');
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
  return { provider, streamCalls };
}

/** 收集 async iterable 到数组 */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iter) {
    result.push(item);
  }
  return result;
}

const baseConfig = {
  provider: {} as LLMProvider,
  executeTool: vi.fn(async () => 'tool result'),
  maxTurns: 10,
};

// ─── reactLoop（非流式）──────────────────────────────

describe('reactLoop', () => {
  describe('单轮直答（无 tool call）', () => {
    it('LLM 直接返回 stop,返回 content + turns=1', async () => {
      const { provider } = createMockProvider([
        llmResponse({ content: 'Hello!', stopReason: 'stop' }),
      ]);

      const result = await reactLoop('hi', {
        provider,
        executeTool: baseConfig.executeTool,
      });

      expect(result.content).toBe('Hello!');
      expect(result.turns).toBe(1);
      expect(result.stopReason).toBe('stop');
      expect(result.usage).toBeUndefined();
    });

    it('systemPrompt 被作为 system 消息插入 messages', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);

      await reactLoop('hi', {
        provider,
        systemPrompt: 'You are a helpful assistant.',
        executeTool: baseConfig.executeTool,
      });

      const request = completeCalls.mock.calls[0][0];
      expect(request.messages[0]).toEqual({
        role: 'system',
        content: 'You are a helpful assistant.',
      });
      expect(request.messages[1]).toEqual({
        role: 'user',
        content: 'hi',
      });
    });

    it('无 systemPrompt 时不插入 system 消息', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);

      await reactLoop('hi', { provider, executeTool: baseConfig.executeTool });

      const request = completeCalls.mock.calls[0][0];
      expect(request.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('usage 透传到结果', async () => {
      const { provider } = createMockProvider([
        llmResponse({
          content: 'ok',
          stopReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        }),
      ]);

      const result = await reactLoop('hi', { provider, executeTool: baseConfig.executeTool });

      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
    });

    it('stopReason=length 时也正常返回(非 tool_calls 即终止)', async () => {
      const { provider } = createMockProvider([
        llmResponse({ content: 'truncated', stopReason: 'length' }),
      ]);

      const result = await reactLoop('hi', { provider, executeTool: baseConfig.executeTool });

      expect(result.content).toBe('truncated');
      expect(result.stopReason).toBe('length');
    });
  });

  describe('多轮 tool calling', () => {
    it('LLM 调 1 次 tool 后返回最终答案(turns=2)', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({
          content: '',
          toolCalls: [{ id: 'call_1', name: 'search', arguments: { q: 'foo' } }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'Found foo', stopReason: 'stop' }),
      ]);
      const executeTool = vi.fn(async () => 'result-foo');

      const result = await reactLoop('search for foo', {
        provider,
        executeTool,
      });

      expect(result.content).toBe('Found foo');
      expect(result.turns).toBe(2);
      expect(result.stopReason).toBe('stop');

      // executeTool 被调 1 次
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(executeTool.mock.calls[0]).toEqual(['search', { q: 'foo' }]);

      // 第二轮 LLM 调用包含 tool 结果消息
      const secondRequest = completeCalls.mock.calls[1][0];
      const toolMsg = secondRequest.messages.find((m: LLMMessage) => m.role === 'tool');
      expect(toolMsg).toEqual({
        role: 'tool',
        content: 'result-foo',
        toolCallId: 'call_1',
      });
    });

    it('LLM 一次返回多个 tool_calls(并行执行)', async () => {
      const { provider } = createMockProvider([
        llmResponse({
          content: '',
          toolCalls: [
            { id: 'call_1', name: 'search', arguments: { q: 'a' } },
            { id: 'call_2', name: 'read', arguments: { path: '/b' } },
          ],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'done', stopReason: 'stop' }),
      ]);
      const executeTool = vi.fn(async (name: string) => `result-${name}`);

      const result = await reactLoop('do both', { provider, executeTool });

      expect(result.turns).toBe(2);
      expect(executeTool).toHaveBeenCalledTimes(2);
      expect(executeTool.mock.calls[0]).toEqual(['search', { q: 'a' }]);
      expect(executeTool.mock.calls[1]).toEqual(['read', { path: '/b' }]);
    });

    it('多轮 tool 调用(3 轮 LLM,2 次 tool)', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'step1', arguments: {} }],
          stopReason: 'tool_calls',
        }),
        llmResponse({
          toolCalls: [{ id: 'c2', name: 'step2', arguments: {} }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'final', stopReason: 'stop' }),
      ]);
      const executeTool = vi.fn(async (name: string) => `r-${name}`);

      const result = await reactLoop('multi-step', { provider, executeTool });

      expect(result.content).toBe('final');
      expect(result.turns).toBe(3);
      expect(executeTool).toHaveBeenCalledTimes(2);

      // 第三轮 messages 包含两个 tool 结果
      const thirdRequest = completeCalls.mock.calls[2][0];
      const toolMsgs = thirdRequest.messages.filter((m: LLMMessage) => m.role === 'tool');
      expect(toolMsgs).toHaveLength(2);
    });

    it('assistant 消息(含 toolCalls)被加入历史 messages', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({
          content: '',
          toolCalls: [{ id: 'c1', name: 't', arguments: {} }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'done', stopReason: 'stop' }),
      ]);

      await reactLoop('hi', { provider, executeTool: baseConfig.executeTool });

      const secondRequest = completeCalls.mock.calls[1][0];
      // messages: [user, assistant(toolCalls), tool(result)]
      expect(secondRequest.messages).toHaveLength(3);
      expect(secondRequest.messages[1].role).toBe('assistant');
      expect(secondRequest.messages[1].toolCalls).toBeDefined();
    });

    it('tool 结果为非 string 时自动 JSON.stringify', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'getData', arguments: {} }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);
      const executeTool = vi.fn(async () => ({ count: 42, items: ['a', 'b'] }));

      await reactLoop('hi', { provider, executeTool });

      const secondRequest = completeCalls.mock.calls[1][0];
      const toolMsg = secondRequest.messages.find((m: LLMMessage) => m.role === 'tool');
      expect(toolMsg.content).toBe(JSON.stringify({ count: 42, items: ['a', 'b'] }));
    });

    it('tool 结果为 number 时 JSON.stringify', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'count', arguments: {} }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);
      const executeTool = vi.fn(async () => 42);

      await reactLoop('hi', { provider, executeTool });

      const secondRequest = completeCalls.mock.calls[1][0];
      const toolMsg = secondRequest.messages.find((m: LLMMessage) => m.role === 'tool');
      expect(toolMsg.content).toBe('42');
    });

    it('usage 多轮累加', async () => {
      const { provider } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 't', arguments: {} }],
          stopReason: 'tool_calls',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        }),
        llmResponse({
          content: 'ok',
          stopReason: 'stop',
          usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23 },
        }),
      ]);

      const result = await reactLoop('hi', { provider, executeTool: baseConfig.executeTool });

      expect(result.usage).toEqual({
        promptTokens: 30,
        completionTokens: 8,
        totalTokens: 38,
      });
    });

    it('tools 列表传给 LLM complete 请求', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);

      await reactLoop('hi', {
        provider,
        executeTool: baseConfig.executeTool,
        tools: [{ name: 'search', description: 'search web', input: { type: 'object' } }],
      });

      const request = completeCalls.mock.calls[0][0];
      expect(request.tools).toEqual([
        { name: 'search', description: 'search web', input: { type: 'object' } },
      ]);
    });

    it('model / temperature / maxTokens 透传到 LLM 请求', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);

      await reactLoop('hi', {
        provider,
        executeTool: baseConfig.executeTool,
        model: 'gpt-4-turbo',
        temperature: 0.5,
        maxTokens: 1024,
      });

      const request = completeCalls.mock.calls[0][0];
      expect(request.model).toBe('gpt-4-turbo');
      expect(request.temperature).toBe(0.5);
      expect(request.maxTokens).toBe(1024);
    });
  });

  describe('maxTurns 防护', () => {
    it('超出 maxTurns 抛 ReactLoopError(含 turns + maxTurns)', async () => {
      // LLM 永远返回 tool_calls,不终止
      const { provider } = createMockProvider(
        Array.from({ length: 5 }, () =>
          llmResponse({
            toolCalls: [{ id: 'c1', name: 't', arguments: {} }],
            stopReason: 'tool_calls',
          }),
        ),
      );

      try {
        await reactLoop('hi', { provider, executeTool: baseConfig.executeTool, maxTurns: 3 });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ReactLoopError);
        expect((err as ReactLoopError).maxTurns).toBe(3);
        expect((err as Error).message).toMatch(/Max turns/);
      }
    });

    it('maxTurns 默认 10', async () => {
      const responses = Array.from({ length: 11 }, () =>
        llmResponse({
          toolCalls: [{ id: 'c1', name: 't', arguments: {} }],
          stopReason: 'tool_calls',
        }),
      );
      const { provider } = createMockProvider(responses);

      await expect(
        reactLoop('hi', { provider, executeTool: baseConfig.executeTool }),
      ).rejects.toThrowError(ReactLoopError);
    });

    it('maxTurns=1 时,LLM 返回 tool_calls 会抛错(无法继续)', async () => {
      const { provider } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 't', arguments: {} }],
          stopReason: 'tool_calls',
        }),
      ]);

      await expect(
        reactLoop('hi', { provider, executeTool: baseConfig.executeTool, maxTurns: 1 }),
      ).rejects.toThrowError(ReactLoopError);
    });

    it('maxTurns=1 时,LLM 直接 stop 则正常返回', async () => {
      const { provider } = createMockProvider([
        llmResponse({ content: 'answer', stopReason: 'stop' }),
      ]);

      const result = await reactLoop('hi', {
        provider,
        executeTool: baseConfig.executeTool,
        maxTurns: 1,
      });

      expect(result.content).toBe('answer');
      expect(result.turns).toBe(1);
    });
  });

  describe('tool 错误处理', () => {
    it('executeTool 抛错时,错误消息回传 LLM(不传播)', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'fail', arguments: {} }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'recovered', stopReason: 'stop' }),
      ]);
      const executeTool = vi.fn(async () => {
        throw new Error('tool failed: connection refused');
      });

      const result = await reactLoop('hi', { provider, executeTool });

      expect(result.content).toBe('recovered');

      const secondRequest = completeCalls.mock.calls[1][0];
      const toolMsg = secondRequest.messages.find((m: LLMMessage) => m.role === 'tool');
      expect(toolMsg.content).toMatch(/tool failed: connection refused/);
    });

    it('executeTool 抛非 Error 对象时,String(err) 作为 tool 结果', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'fail', arguments: {} }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);
      const executeTool = vi.fn(async () => {
        throw 'string error';
      });

      await reactLoop('hi', { provider, executeTool });

      const secondRequest = completeCalls.mock.calls[1][0];
      const toolMsg = secondRequest.messages.find((m: LLMMessage) => m.role === 'tool');
      expect(toolMsg.content).toBe('string error');
    });

    it('provider.complete 抛错时立即传播(不 catch)', async () => {
      const provider: LLMProvider = {
        complete: async () => {
          throw new Error('LLM API 401');
        },
        stream: async function* () {},
      };

      await expect(
        reactLoop('hi', { provider, executeTool: baseConfig.executeTool }),
      ).rejects.toThrowError(/LLM API 401/);
    });
  });

  describe('ReactLoopResult.messages', () => {
    it('包含完整对话历史(system + user + assistant + tool)', async () => {
      const { provider } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 't', arguments: {} }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'final', stopReason: 'stop' }),
      ]);

      const result = await reactLoop('hi', {
        provider,
        systemPrompt: 'sys',
        executeTool: baseConfig.executeTool,
      });

      expect(result.messages).toHaveLength(5);
      expect(result.messages[0].role).toBe('system');
      expect(result.messages[1].role).toBe('user');
      expect(result.messages[2].role).toBe('assistant');
      expect(result.messages[3].role).toBe('tool');
      expect(result.messages[4].role).toBe('assistant');
      expect(result.messages[4].content).toBe('final');
    });
  });
});

// ─── reactLoopStream（流式）──────────────────────────

describe('reactLoopStream', () => {
  describe('单轮直答', () => {
    it('yield deltaContent chunks + done chunk', async () => {
      const { provider } = createMockStreamProvider([
        [{ deltaContent: 'Hello' }, { deltaContent: ' world' }, { finishReason: 'stop' }],
      ]);

      const chunks = await collect(
        reactLoopStream('hi', { provider, executeTool: baseConfig.executeTool }),
      );

      const deltas = chunks.filter((c) => c.deltaContent !== undefined);
      expect(deltas.map((c) => c.deltaContent).join('')).toBe('Hello world');

      const done = chunks.find((c) => c.done !== undefined);
      expect(done!.done).toEqual({
        content: 'Hello world',
        turns: 1,
        stopReason: 'stop',
        usage: undefined,
      });
    });

    it('无 deltaContent 时 done.content 为空字符串', async () => {
      const { provider } = createMockStreamProvider([[{ finishReason: 'stop' }]]);

      const chunks = await collect(
        reactLoopStream('hi', { provider, executeTool: baseConfig.executeTool }),
      );

      const done = chunks.find((c) => c.done !== undefined);
      expect(done!.done!.content).toBe('');
    });

    it('usage 透传到 done chunk', async () => {
      const { provider } = createMockStreamProvider([
        [
          { deltaContent: 'x' },
          {
            finishReason: 'stop',
            usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
          },
        ],
      ]);

      const chunks = await collect(
        reactLoopStream('hi', { provider, executeTool: baseConfig.executeTool }),
      );

      const done = chunks.find((c) => c.done !== undefined);
      expect(done!.done!.usage).toEqual({
        promptTokens: 5,
        completionTokens: 1,
        totalTokens: 6,
      });
    });
  });

  describe('多轮 tool calling', () => {
    it('yield deltaContent + toolCall + toolResult + done', async () => {
      const { provider } = createMockStreamProvider([
        // 第一轮:LLM 流式输出 + tool_calls
        [
          { deltaContent: '' },
          {
            toolCalls: [{ id: 'c1', name: 'search', arguments: { q: 'foo' } }],
            finishReason: 'tool_calls',
          },
        ],
        // 第二轮:LLM 流式输出最终答案
        [{ deltaContent: 'Found ' }, { deltaContent: 'it' }, { finishReason: 'stop' }],
      ]);
      const executeTool = vi.fn(async () => 'result-foo');

      const chunks = await collect(reactLoopStream('search foo', { provider, executeTool }));

      // 第一轮 deltaContent（空字符串不 yield,但最终 chunk 无 deltaContent）
      const toolCallChunk = chunks.find((c) => c.toolCall !== undefined);
      expect(toolCallChunk!.toolCall).toEqual({
        name: 'search',
        arguments: { q: 'foo' },
      });

      const toolResultChunk = chunks.find((c) => c.toolResult !== undefined);
      expect(toolResultChunk!.toolResult).toEqual({
        name: 'search',
        result: 'result-foo',
      });

      // 第二轮 deltaContent
      const deltas = chunks.filter((c) => c.deltaContent !== undefined);
      expect(deltas.map((c) => c.deltaContent).join('')).toBe('Found it');

      const done = chunks.find((c) => c.done !== undefined);
      expect(done!.done).toEqual({
        content: 'Found it',
        turns: 2,
        stopReason: 'stop',
        usage: undefined,
      });
    });

    it('多轮 tool + usage 累加', async () => {
      const { provider } = createMockStreamProvider([
        [
          {
            toolCalls: [{ id: 'c1', name: 't', arguments: {} }],
            finishReason: 'tool_calls',
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
        ],
        [
          { deltaContent: 'ok' },
          {
            finishReason: 'stop',
            usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23 },
          },
        ],
      ]);

      const chunks = await collect(
        reactLoopStream('hi', { provider, executeTool: baseConfig.executeTool }),
      );

      const done = chunks.find((c) => c.done !== undefined);
      expect(done!.done!.usage).toEqual({
        promptTokens: 30,
        completionTokens: 8,
        totalTokens: 38,
      });
    });

    it('多个 tool_calls 逐一 yield toolCall + toolResult', async () => {
      const { provider } = createMockStreamProvider([
        [
          {
            toolCalls: [
              { id: 'c1', name: 'search', arguments: { q: 'a' } },
              { id: 'c2', name: 'read', arguments: { path: '/b' } },
            ],
            finishReason: 'tool_calls',
          },
        ],
        [{ deltaContent: 'done' }, { finishReason: 'stop' }],
      ]);
      const executeTool = vi.fn(async (name: string) => `r-${name}`);

      const chunks = await collect(reactLoopStream('hi', { provider, executeTool }));

      const toolCalls = chunks.filter((c) => c.toolCall !== undefined);
      expect(toolCalls).toHaveLength(2);

      const toolResults = chunks.filter((c) => c.toolResult !== undefined);
      expect(toolResults).toHaveLength(2);
      expect(toolResults[0].toolResult).toEqual({ name: 'search', result: 'r-search' });
      expect(toolResults[1].toolResult).toEqual({ name: 'read', result: 'r-read' });
    });
  });

  describe('tool 错误处理', () => {
    it('executeTool 抛错时,错误消息作为 toolResult 回传 LLM', async () => {
      const { provider } = createMockStreamProvider([
        [
          {
            toolCalls: [{ id: 'c1', name: 'fail', arguments: {} }],
            finishReason: 'tool_calls',
          },
        ],
        [{ deltaContent: 'recovered' }, { finishReason: 'stop' }],
      ]);
      const executeTool = vi.fn(async () => {
        throw new Error('connection refused');
      });

      const chunks = await collect(reactLoopStream('hi', { provider, executeTool }));

      const toolResultChunk = chunks.find((c) => c.toolResult !== undefined);
      expect(toolResultChunk!.toolResult!.result).toMatch(/connection refused/);

      const done = chunks.find((c) => c.done !== undefined);
      expect(done!.done!.content).toBe('recovered');
    });
  });

  describe('maxTurns 防护', () => {
    it('超出 maxTurns 抛 ReactLoopError', async () => {
      const { provider } = createMockStreamProvider([
        [
          {
            toolCalls: [{ id: 'c1', name: 't', arguments: {} }],
            finishReason: 'tool_calls',
          },
        ],
        [
          {
            toolCalls: [{ id: 'c2', name: 't', arguments: {} }],
            finishReason: 'tool_calls',
          },
        ],
      ]);

      await expect(
        collect(
          reactLoopStream('hi', {
            provider,
            executeTool: baseConfig.executeTool,
            maxTurns: 2,
          }),
        ),
      ).rejects.toThrowError(ReactLoopError);
    });
  });

  describe('systemPrompt + 请求构造', () => {
    it('systemPrompt 插入 messages + tools 透传', async () => {
      const { provider, streamCalls } = createMockStreamProvider([
        [{ deltaContent: 'ok' }, { finishReason: 'stop' }],
      ]);

      await collect(
        reactLoopStream('hi', {
          provider,
          systemPrompt: 'be helpful',
          executeTool: baseConfig.executeTool,
          tools: [{ name: 't', description: 'd', input: { type: 'object' } }],
        }),
      );

      const request = streamCalls.mock.calls[0][0];
      expect(request.messages[0]).toEqual({ role: 'system', content: 'be helpful' });
      expect(request.tools).toEqual([{ name: 't', description: 'd', input: { type: 'object' } }]);
    });
  });
});
