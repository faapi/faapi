import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createOpenAIProvider, LLMProviderError } from './openai';
import type { LlmConfig } from '@faapi/faapi';

/** 构造 OpenAI chat completions 成功响应 body */
function openaiResponse(opts: {
  content?: string | null;
  toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}): unknown {
  const message: Record<string, unknown> = { role: 'assistant' };
  message.content = opts.content ?? '';
  if (opts.toolCalls) {
    message.tool_calls = opts.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message,
        finish_reason: opts.finishReason ?? (opts.toolCalls ? 'tool_calls' : 'stop'),
      },
    ],
    usage: opts.usage,
  };
}

/** 构造 fetch mock 返回标准 Response */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 构造 SSE 流 Response(可发送多个 data: 行) */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** 构造 SSE data 行(用 JSON.stringify 避免 manual 转义) */
function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** SSE [DONE] 行 */
const SSE_DONE = 'data: [DONE]\n\n';

const baseConfig: LlmConfig = {
  provider: 'openai',
  apiKey: 'sk-test-key',
  models: { 'gpt-4o': {} },
};

describe('createOpenAIProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('complete — 基础成功路径', () => {
    it('纯文本响应:返回 message.content + stopReason=stop', async () => {
      fetchMock.mockResolvedValue(jsonResponse(openaiResponse({ content: 'Hello!' })));

      const provider = createOpenAIProvider(baseConfig);
      const res = await provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(res.message.role).toBe('assistant');
      expect(res.message.content).toBe('Hello!');
      expect(res.message.toolCalls).toBeUndefined();
      expect(res.stopReason).toBe('stop');
      expect(res.usage).toBeUndefined();
    });

    it('tool_calls 响应:返回 toolCalls + stopReason=tool_calls,arguments 已 JSON.parse', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          openaiResponse({
            content: null,
            toolCalls: [
              { id: 'call_1', function: { name: 'search', arguments: '{"q":"foo"}' } },
              { id: 'call_2', function: { name: 'read', arguments: '{"path":"/tmp"}' } },
            ],
          }),
        ),
      );

      const provider = createOpenAIProvider(baseConfig);
      const res = await provider.complete({
        messages: [{ role: 'user', content: 'search and read' }],
        tools: [{ name: 'search', description: 'search web', input: { type: 'object' } }],
      });

      expect(res.stopReason).toBe('tool_calls');
      expect(res.message.toolCalls).toEqual([
        { id: 'call_1', name: 'search', arguments: { q: 'foo' } },
        { id: 'call_2', name: 'read', arguments: { path: '/tmp' } },
      ]);
    });

    it('usage 字段透传(prompt/completion/total tokens)', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          openaiResponse({
            content: 'ok',
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        ),
      );

      const provider = createOpenAIProvider(baseConfig);
      const res = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

      expect(res.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
    });

    it('message.content=null 时统一为空字符串', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          openaiResponse({
            content: null,
            toolCalls: [{ id: 'call_1', function: { name: 'x', arguments: '{}' } }],
          }),
        ),
      );

      const provider = createOpenAIProvider(baseConfig);
      const res = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

      expect(res.message.content).toBe('');
    });

    it('finish_reason 映射: length / content_filter / 其他 → 对应枚举', async () => {
      const cases: Array<[string, string]> = [
        ['stop', 'stop'],
        ['tool_calls', 'tool_calls'],
        ['length', 'length'],
        ['content_filter', 'content_filter'],
        ['unknown_thing', 'other'],
      ];

      for (const [reason, expected] of cases) {
        fetchMock.mockResolvedValue(
          jsonResponse(openaiResponse({ content: 'x', finishReason: reason })),
        );
        const provider = createOpenAIProvider(baseConfig);
        const res = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
        expect(res.stopReason).toBe(expected);
      }
    });
  });

  describe('complete — 请求构造', () => {
    it('发送 Authorization: Bearer <apiKey> 头', async () => {
      fetchMock.mockResolvedValue(jsonResponse(openaiResponse({ content: 'ok' })));

      const provider = createOpenAIProvider({ ...baseConfig, apiKey: 'sk-secret' });
      await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers.Authorization).toBe('Bearer sk-secret');
      expect(init.headers['Content-Type']).toBe('application/json');
    });

    it('未提供 request.model 时用 config.models 第一个 key', async () => {
      fetchMock.mockResolvedValue(jsonResponse(openaiResponse({ content: 'ok' })));

      const provider = createOpenAIProvider({
        ...baseConfig,
        models: { 'gpt-4o-mini': {} },
      });
      await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-4o-mini');
    });

    it('request.model 覆盖 config.models 第一个 key', async () => {
      fetchMock.mockResolvedValue(jsonResponse(openaiResponse({ content: 'ok' })));

      const provider = createOpenAIProvider({ ...baseConfig, models: { 'gpt-4o': {} } });
      await provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-4-turbo',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-4-turbo');
    });

    it('model 级字段覆盖 provider 级同名字段（temperature）', async () => {
      fetchMock.mockResolvedValue(jsonResponse(openaiResponse({ content: 'ok' })));

      // provider 级 temperature=0.3,model 'gpt-4o-mini' 覆盖为 0.5
      const provider = createOpenAIProvider({
        ...baseConfig,
        temperature: 0.3,
        models: { 'gpt-4o': {}, 'gpt-4o-mini': { temperature: 0.5 } },
      });
      await provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-4o-mini',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-4o-mini');
      expect(body.temperature).toBe(0.5); // model 级覆盖 provider 级
    });

    it('request.temperature 覆盖 model 级与 provider 级 temperature', async () => {
      fetchMock.mockResolvedValue(jsonResponse(openaiResponse({ content: 'ok' })));

      const provider = createOpenAIProvider({
        ...baseConfig,
        temperature: 0.3,
        models: { 'gpt-4o-mini': { temperature: 0.5 } },
      });
      await provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-4o-mini',
        temperature: 0.9,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.9); // request 级最高优先
    });

    it('config.baseURL 指向中转服务(覆盖默认 OpenAI 端点)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(openaiResponse({ content: 'ok' })));

      const provider = createOpenAIProvider({
        ...baseConfig,
        baseURL: 'https://llm-relay.example.com/v1',
      });
      await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

      const url = fetchMock.mock.calls[0][0];
      expect(url).toBe('https://llm-relay.example.com/v1/chat/completions');
    });

    it('未设 baseURL 时默认 https://api.openai.com/v1', async () => {
      fetchMock.mockResolvedValue(jsonResponse(openaiResponse({ content: 'ok' })));

      const provider = createOpenAIProvider(baseConfig);
      await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

      const url = fetchMock.mock.calls[0][0];
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
    });

    it('tools 转换为 OpenAI function calling 格式', async () => {
      fetchMock.mockResolvedValue(jsonResponse(openaiResponse({ content: 'ok' })));

      const provider = createOpenAIProvider(baseConfig);
      await provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'search',
            description: 'search web',
            input: { type: 'object', properties: { q: { type: 'string' } } },
          },
        ],
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'search',
            description: 'search web',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
          },
        },
      ]);
    });

    it('temperature / maxTokens 透传到请求体', async () => {
      fetchMock.mockResolvedValue(jsonResponse(openaiResponse({ content: 'ok' })));

      const provider = createOpenAIProvider(baseConfig);
      await provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.7,
        maxTokens: 1024,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(1024);
    });

    it('config 额外字段透传(如 top_p / max_tokens)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(openaiResponse({ content: 'ok' })));

      const provider = createOpenAIProvider({
        ...baseConfig,
        top_p: 0.9,
        max_tokens: 2048,
      });
      await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.top_p).toBe(0.9);
      expect(body.max_tokens).toBe(2048);
    });

    it('assistant + tool 消息在 messages 数组中保留(多轮 tool 调用)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(openaiResponse({ content: 'done' })));

      const provider = createOpenAIProvider(baseConfig);
      await provider.complete({
        messages: [
          { role: 'user', content: 'search foo' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'search', arguments: { q: 'foo' } }],
          },
          { role: 'tool', content: 'result-foo', toolCallId: 'call_1' },
        ],
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages).toHaveLength(3);
      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"foo"}' },
          },
        ],
      });
      expect(body.messages[2]).toEqual({
        role: 'tool',
        content: 'result-foo',
        tool_call_id: 'call_1',
      });
    });
  });

  describe('complete — 错误路径', () => {
    it('HTTP 401 抛 LLMProviderError(含 status + body 摘要)', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid api key' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const provider = createOpenAIProvider(baseConfig);
      try {
        await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMProviderError);
        expect((err as LLMProviderError).status).toBe(401);
        expect((err as LLMProviderError).body).toContain('invalid api key');
        expect((err as Error).message).toMatch(/401/);
      }
    });

    it('HTTP 500 抛 LLMProviderError(status=500)', async () => {
      fetchMock.mockResolvedValue(new Response('internal server error', { status: 500 }));

      const provider = createOpenAIProvider(baseConfig);
      await expect(
        provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrowError(/500/);
    });

    it('网络错误(fetch reject)抛 LLMProviderError(status=undefined)', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED'));

      const provider = createOpenAIProvider(baseConfig);
      try {
        await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMProviderError);
        expect((err as LLMProviderError).status).toBeUndefined();
        expect((err as Error).message).toMatch(/Network error/i);
      }
    });

    it('响应 JSON 解析失败抛 LLMProviderError', async () => {
      fetchMock.mockResolvedValue(
        new Response('not json at all', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const provider = createOpenAIProvider(baseConfig);
      await expect(
        provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrowError(/Invalid JSON response/i);
    });

    it('choices 为空抛 LLMProviderError', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ id: 'x', object: 'chat.completion', choices: [] }),
      );

      const provider = createOpenAIProvider(baseConfig);
      await expect(
        provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrowError(/Empty choices/i);
    });

    it('tool_calls.arguments 非法 JSON 抛 LLMProviderError', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          openaiResponse({
            toolCalls: [{ id: 'call_1', function: { name: 'search', arguments: '{invalid' } }],
          }),
        ),
      );

      const provider = createOpenAIProvider(baseConfig);
      await expect(
        provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrowError(/Invalid tool arguments JSON/i);
    });
  });

  describe('stream — 基础成功路径', () => {
    it('逐 chunk 推送 deltaContent + 最终 finishReason=stop', async () => {
      fetchMock.mockResolvedValue(
        sseResponse([
          sseData({ choices: [{ delta: { content: 'Hello' } }] }),
          sseData({ choices: [{ delta: { content: ' world' } }] }),
          sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          SSE_DONE,
        ]),
      );

      const provider = createOpenAIProvider(baseConfig);
      const chunks = [];
      for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(chunk);
      }

      // 至少含 deltaContent chunks + 终止 chunk
      const contents = chunks.map((c) => c.deltaContent ?? '').join('');
      expect(contents).toBe('Hello world');

      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.finishReason).toBe('stop');
    });

    it('流式累积 tool_calls,完成时 emit toolCalls', async () => {
      fetchMock.mockResolvedValue(
        sseResponse([
          sseData({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'search', arguments: '' },
                    },
                  ],
                },
              },
            ],
          }),
          sseData({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"q":' } }],
                },
              },
            ],
          }),
          sseData({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '"foo"}' } }],
                },
              },
            ],
          }),
          sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          SSE_DONE,
        ]),
      );

      const provider = createOpenAIProvider(baseConfig);
      const chunks = [];
      for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(chunk);
      }

      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.finishReason).toBe('tool_calls');
      expect(finalChunk.toolCalls).toEqual([
        { id: 'call_1', name: 'search', arguments: { q: 'foo' } },
      ]);
    });

    it('使用 token 的 usage 在最后一个 chunk 出现', async () => {
      fetchMock.mockResolvedValue(
        sseResponse([
          sseData({ choices: [{ delta: { content: 'hi' } }] }),
          sseData({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }),
          SSE_DONE,
        ]),
      );

      const provider = createOpenAIProvider(baseConfig);
      const chunks = [];
      for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(chunk);
      }

      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.usage).toEqual({
        promptTokens: 5,
        completionTokens: 1,
        totalTokens: 6,
      });
    });

    it('请求体含 stream: true', async () => {
      fetchMock.mockResolvedValue(
        sseResponse([
          sseData({ choices: [{ delta: { content: 'x' } }] }),
          sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          SSE_DONE,
        ]),
      );

      const provider = createOpenAIProvider(baseConfig);
      const iter = provider.stream({ messages: [{ role: 'user', content: 'hi' }] });
      // 触发 fetch
      await iter[Symbol.asyncIterator]().next();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.stream).toBe(true);
    });
  });

  describe('stream — 错误路径', () => {
    it('HTTP 错误抛 LLMProviderError', async () => {
      fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));

      const provider = createOpenAIProvider(baseConfig);
      await expect(async () => {
        for await (const _ of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
          // 不应该到这里
        }
      }).rejects.toThrowError(/401/);
    });

    it('SSE chunk 非法 JSON 抛 LLMProviderError', async () => {
      fetchMock.mockResolvedValue(sseResponse(['data: not-valid-json\n\n']));

      const provider = createOpenAIProvider(baseConfig);
      await expect(async () => {
        for await (const _ of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
          // 不应该到这里
        }
      }).rejects.toThrowError(/Invalid SSE chunk/i);
    });
  });
});
