import { describe, it, expect, vi } from 'vitest';
import { reactLoop, reactLoopStream, ReactLoopError } from './reactLoop';
import { AgentAbortError } from './provider';
import type {
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  LLMMessage,
  LLMUsage,
  LLMStopReason,
} from './provider';
import type { AgentTrace, TracingToolResult } from './trace';

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

// ─── tracing（结构化调用明细）─────────────────────────

describe('tracing — reactLoop + reactLoopStream', () => {
  /**
   * tracing 默认关闭（enableTracing 默认 false——opt-in,不开启零开销）,
   * 需要观测的调用显式传 enableTracing: true 开启。
   *
   * ReactLoopResult.trace 填充 AgentTrace,事件按发生顺序排列。
   * 流式版本通过 ReactLoopStreamChunk.traceEvent 增量推送。
   */
  const usage: LLMUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

  /** 构造一个 sub-agent trace（用于 TracingToolResult 测试） */
  function makeSubTrace(name: string): AgentTrace {
    return {
      agentName: name,
      startedAt: 100,
      durationMs: 50,
      turns: 1,
      usage,
      stopReason: 'stop',
      content: `sub-result-${name}`,
      events: [
        {
          type: 'llm_call',
          turn: 1,
          startedAt: 100,
          durationMs: 50,
          model: 'gpt-4o',
          inputMessages: [{ role: 'user', content: 'sub-input' }],
          response: { role: 'assistant', content: `sub-result-${name}` },
          stopReason: 'stop',
          usage,
        },
      ],
    };
  }

  describe('reactLoop — 非流式 tracing', () => {
    it('显式开启:单轮直答 trace 结构完整', async () => {
      const { provider } = createMockProvider([
        llmResponse({ content: 'Hello!', stopReason: 'stop', usage }),
      ]);

      const result = await reactLoop('hi', {
        provider,
        model: 'gpt-4o',
        executeTool: baseConfig.executeTool,
        enableTracing: true,
      });

      expect(result.trace).toBeDefined();
      const trace = result.trace!;
      expect(trace.agentName).toBe(''); // reactLoop 自身不知 agent 名,Agent 类填入
      expect(trace.turns).toBe(1);
      expect(trace.usage).toEqual(usage);
      expect(trace.stopReason).toBe('stop');
      expect(trace.content).toBe('Hello!');
      expect(trace.durationMs).toBeGreaterThanOrEqual(0);
      expect(trace.events).toHaveLength(1);

      const evt = trace.events[0]!;
      expect(evt.type).toBe('llm_call');
      if (evt.type === 'llm_call') {
        expect(evt.turn).toBe(1);
        expect(evt.model).toBe('gpt-4o');
        expect(evt.stopReason).toBe('stop');
        expect(evt.usage).toEqual(usage);
        // inputMessages 是浅拷贝快照,含该轮的 system(无) + user
        expect(evt.inputMessages).toHaveLength(1);
        expect(evt.inputMessages[0]!.role).toBe('user');
        expect(evt.response).toEqual({
          role: 'assistant',
          content: 'Hello!',
        });
      }
    });

    it('默认关闭:不传 enableTracing 时 trace 为 undefined（零开销）', async () => {
      const { provider } = createMockProvider([
        llmResponse({ content: 'Hello!', stopReason: 'stop' }),
      ]);

      const result = await reactLoop('hi', {
        provider,
        executeTool: baseConfig.executeTool,
      });

      expect(result.trace).toBeUndefined();
    });

    it('enableTracing=false:trace 为 undefined(零开销)', async () => {
      const { provider } = createMockProvider([
        llmResponse({ content: 'Hello!', stopReason: 'stop' }),
      ]);

      const result = await reactLoop('hi', {
        provider,
        executeTool: baseConfig.executeTool,
        enableTracing: false,
      });

      expect(result.trace).toBeUndefined();
    });

    it('2 轮 trace:llm_call → tool_call → llm_call 顺序正确', async () => {
      const { provider } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'search', arguments: { q: 'foo' } }],
          stopReason: 'tool_calls',
          usage,
        }),
        llmResponse({ content: 'final', stopReason: 'stop', usage }),
      ]);

      const result = await reactLoop('hi', {
        provider,
        model: 'gpt-4o',
        executeTool: async () => 'search-result',
        enableTracing: true,
      });

      const trace = result.trace!;
      expect(trace.turns).toBe(2);
      expect(trace.events).toHaveLength(3);

      const [llm1, tool1, llm2] = trace.events;
      expect(llm1!.type).toBe('llm_call');
      expect(llm1!.turn).toBe(1);
      expect(tool1!.type).toBe('tool_call');
      expect(tool1!.turn).toBe(1);
      expect(llm2!.type).toBe('llm_call');
      expect(llm2!.turn).toBe(2);

      if (tool1!.type === 'tool_call') {
        expect(tool1!.toolCallId).toBe('c1');
        expect(tool1!.name).toBe('search');
        expect(tool1!.arguments).toEqual({ q: 'foo' });
        expect(tool1!.result).toBe('search-result');
        expect(tool1!.error).toBeUndefined();
      }

      // 第 2 轮 llm_call 的 inputMessages 含第 1 轮追加的 assistant + tool 消息
      // 顺序:user(1) + assistant(1,含 tool_calls) + tool(1) = 3 条
      if (llm2!.type === 'llm_call') {
        expect(llm2!.inputMessages).toHaveLength(3);
        expect(llm2!.inputMessages[0]!.role).toBe('user');
        expect(llm2!.inputMessages[1]!.role).toBe('assistant');
        expect(llm2!.inputMessages[2]!.role).toBe('tool');
      }
    });

    it('sub-agent 调用(executeTool 返回 TracingToolResult):trace 含 subagent_call 事件', async () => {
      const subTrace = makeSubTrace('translator');
      const { provider } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'agent.translator', arguments: { input: 'hi' } }],
          stopReason: 'tool_calls',
          usage,
        }),
        llmResponse({ content: 'final', stopReason: 'stop', usage }),
      ]);

      const tracingResult: TracingToolResult = {
        __trace: true,
        result: 'sub-result-translator',
        trace: subTrace,
      };
      const executeTool = vi.fn(async () => tracingResult);

      const result = await reactLoop('hi', {
        provider,
        model: 'gpt-4o',
        executeTool,
        enableTracing: true,
      });

      const trace = result.trace!;
      const subEvt = trace.events.find((e) => e.type === 'subagent_call');
      expect(subEvt).toBeDefined();
      if (subEvt!.type === 'subagent_call') {
        expect(subEvt!.agentName).toBe('translator');
        expect(subEvt!.input).toBe(JSON.stringify({ input: 'hi' }));
        expect(subEvt!.trace).toEqual(subTrace); // 嵌套递归 trace
        expect(subEvt!.result).toBe('sub-result-translator');
        expect(subEvt!.toolCallId).toBe('c1');
      }

      // messages 里 tool 消息内容是 TracingToolResult.result stringifyResult 后的值
      const toolMsg = result.messages.find((m) => m.role === 'tool');
      expect(toolMsg!.content).toBe('sub-result-translator');
    });

    it('tool 抛错:tool_call 事件含 error 字段,result 为 stringifyError', async () => {
      const { provider } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'fail', arguments: {} }],
          stopReason: 'tool_calls',
          usage,
        }),
        llmResponse({ content: 'final', stopReason: 'stop', usage }),
      ]);

      const executeTool = vi.fn(async () => {
        throw new Error('boom');
      });

      const result = await reactLoop('hi', {
        provider,
        model: 'gpt-4o',
        executeTool,
        enableTracing: true,
      });

      const trace = result.trace!;
      const toolEvt = trace.events.find((e) => e.type === 'tool_call');
      if (toolEvt!.type === 'tool_call') {
        expect(toolEvt!.error).toBeDefined();
        expect(toolEvt!.result).toContain('boom');
      }
    });
  });

  describe('reactLoopStream — 流式 tracing', () => {
    it('显式开启:traceEvent chunk 与 deltaContent/toolCall/toolResult/done 平行推送', async () => {
      const { provider } = createMockStreamProvider([
        [
          { deltaContent: 'Hello' },
          { deltaContent: ' world' },
          {
            toolCalls: [{ id: 'c1', name: 'search', arguments: { q: 'foo' } }],
            finishReason: 'tool_calls',
            usage,
          },
        ],
        [{ deltaContent: 'final' }, { finishReason: 'stop', usage }],
      ]);

      const chunks = await collect(
        reactLoopStream('hi', {
          provider,
          model: 'gpt-4o',
          executeTool: async () => 'search-result',
          enableTracing: true,
        }),
      );

      const traceEvents = chunks.filter((c) => c.traceEvent !== undefined);
      expect(traceEvents.length).toBeGreaterThanOrEqual(3); // llm_call + tool_call + llm_call

      const types = traceEvents.map((c) => c.traceEvent!.type);
      expect(types).toContain('llm_call');
      expect(types).toContain('tool_call');

      // done chunk 含完整 trace 镜像
      const done = chunks.find((c) => c.done !== undefined);
      expect(done!.done).toBeDefined();
    });

    it('enableTracing=false:无 traceEvent chunk', async () => {
      const { provider } = createMockStreamProvider([
        [{ deltaContent: 'ok' }, { finishReason: 'stop' }],
      ]);

      const chunks = await collect(
        reactLoopStream('hi', {
          provider,
          executeTool: baseConfig.executeTool,
          enableTracing: false,
        }),
      );

      const traceEvents = chunks.filter((c) => c.traceEvent !== undefined);
      expect(traceEvents).toHaveLength(0);
    });

    it('默认关闭:不传 enableTracing 时无 traceEvent chunk', async () => {
      const { provider } = createMockStreamProvider([
        [{ deltaContent: 'ok' }, { finishReason: 'stop' }],
      ]);

      const chunks = await collect(
        reactLoopStream('hi', {
          provider,
          executeTool: baseConfig.executeTool,
        }),
      );

      const traceEvents = chunks.filter((c) => c.traceEvent !== undefined);
      expect(traceEvents).toHaveLength(0);
    });

    it('sub-agent 调用:流式 traceEvent 含 subagent_call 事件', async () => {
      const subTrace = makeSubTrace('translator');
      const { provider } = createMockStreamProvider([
        [
          {
            toolCalls: [{ id: 'c1', name: 'agent.translator', arguments: { input: 'hi' } }],
            finishReason: 'tool_calls',
            usage,
          },
        ],
        [{ deltaContent: 'final' }, { finishReason: 'stop', usage }],
      ]);

      const tracingResult: TracingToolResult = {
        __trace: true,
        result: 'sub-result-translator',
        trace: subTrace,
      };

      const chunks = await collect(
        reactLoopStream('hi', {
          provider,
          model: 'gpt-4o',
          executeTool: async () => tracingResult,
          enableTracing: true,
        }),
      );

      const traceEvents = chunks.filter((c) => c.traceEvent !== undefined);
      const subEvt = traceEvents.find((c) => c.traceEvent!.type === 'subagent_call');
      expect(subEvt).toBeDefined();
      if (subEvt!.traceEvent!.type === 'subagent_call') {
        expect(subEvt!.traceEvent!.agentName).toBe('translator');
        expect(subEvt!.traceEvent!.trace).toEqual(subTrace);
      }
    });
  });

  it('config.signal 已 aborted → 循环开始前抛 AgentAbortError,provider 未被调用', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse({ content: 'x' })]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      reactLoop('hi', {
        provider,
        executeTool: async () => '',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AgentAbortError);
    expect(completeCalls).not.toHaveBeenCalled();
  });

  it('signal 透传到 provider.complete 的请求参数', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse({ content: 'ok' })]);
    const controller = new AbortController();

    await reactLoop('hi', {
      provider,
      executeTool: async () => '',
      signal: controller.signal,
    });
    expect(completeCalls).toHaveBeenCalledTimes(1);
    expect(completeCalls.mock.calls[0][0]).toMatchObject({ signal: controller.signal });
  });
});
