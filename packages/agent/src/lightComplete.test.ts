import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLightComplete, LLMProviderError, LLMTimeoutError } from './index';
import { AgentError } from './agent';
import { AgentAbortError } from './provider';
import type { LLMProvider, LLMResponse, LLMCompleteRequest } from './provider';
import type { LlmConfig } from '@faapi/faapi';

/**
 * 轻量 LLM 补全通道（lightComplete）行为定义
 *
 * 传输机制复用 provider（重试/超时/错误分型由 openai.test.ts 覆盖），
 * 本文件覆盖：model key 解析、消息组装、request 级覆盖转发、默认超时、
 * 失败语义（onFailure / fallback / 不可静默）与取消语义。
 */

/** 构造成功 LLMResponse */
function llmResponse(content: string, attempts?: number): LLMResponse {
  return {
    message: { role: 'assistant', content },
    stopReason: 'stop',
    ...(attempts !== undefined ? { attempts } : {}),
  };
}

/** 创建 mock LLMProvider（记录 complete 入参，按脚本返回/抛错） */
function createMockProvider(script: Array<LLMResponse | Error>): {
  provider: LLMProvider;
  completeCalls: LLMCompleteRequest[];
} {
  const completeCalls: LLMCompleteRequest[] = [];
  let callIndex = 0;
  const provider: LLMProvider = {
    complete: async (request) => {
      completeCalls.push(request);
      const step = script[callIndex++];
      if (!step) throw new Error('No more mock steps');
      if (step instanceof Error) throw step;
      return step;
    },
    stream: () => {
      throw new Error('stream not mocked');
    },
  };
  return { provider, completeCalls };
}

/** 默认 llms 配置（双 model，便于 key 解析测试） */
function defaultLlms(): Record<string, LlmConfig> {
  return {
    openai: { provider: 'openai', apiKey: 'k', models: { 'gpt-4o': {}, 'gpt-4o-mini': {} } },
  };
}

/** 用注入的 mock provider 构造 channel */
function channelWith(
  provider: LLMProvider,
  llms: Record<string, LlmConfig> = defaultLlms(),
): ReturnType<typeof createLightComplete> {
  return createLightComplete({ llms, providers: new Map([['openai', provider]]) });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLightComplete', () => {
  // ─── 基本流程 ──────────────────────────────────────

  it('成功：返回 assistant content 字符串', async () => {
    const { provider } = createMockProvider([llmResponse('分类结果')]);
    const llm = channelWith(provider);
    await expect(llm.complete('输入文本')).resolves.toBe('分类结果');
  });

  it('消息组装：无 system 时仅 user 消息', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok')]);
    const llm = channelWith(provider);
    await llm.complete('输入文本');
    expect(completeCalls[0]!.messages).toEqual([{ role: 'user', content: '输入文本' }]);
  });

  it('消息组装：system 前置', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok')]);
    const llm = channelWith(provider);
    await llm.complete('输入文本', { system: '只输出标签' });
    expect(completeCalls[0]!.messages).toEqual([
      { role: 'system', content: '只输出标签' },
      { role: 'user', content: '输入文本' },
    ]);
  });

  it('透传 temperature / maxTokens / signal', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok')]);
    const llm = channelWith(provider);
    const controller = new AbortController();
    await llm.complete('x', {
      temperature: 0.3,
      maxTokens: 100,
      signal: controller.signal,
    });
    expect(completeCalls[0]!.temperature).toBe(0.3);
    expect(completeCalls[0]!.maxTokens).toBe(100);
    expect(completeCalls[0]!.signal).toBe(controller.signal);
  });

  it('不发 tools——轻量通道不传工具，LLM 不会请求 tool_call', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok')]);
    const llm = channelWith(provider);
    await llm.complete('x');
    expect(completeCalls[0]!.tools).toBeUndefined();
  });

  // ─── model key 解析（与 agent.run 同规则） ──────────────

  it('model 解析：llms key 精确匹配 → 该 provider 第一个 model', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok')]);
    const llm = channelWith(provider);
    await llm.complete('x', { model: 'openai' });
    expect(completeCalls[0]!.model).toBe('gpt-4o');
  });

  it('model 解析：provider/model 一体化形式', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok')]);
    const llm = channelWith(provider);
    await llm.complete('x', { model: 'openai/gpt-4o-mini' });
    expect(completeCalls[0]!.model).toBe('gpt-4o-mini');
  });

  it('model 解析：纯 model 名全 provider 查找', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok')]);
    const llm = channelWith(provider);
    await llm.complete('x', { model: 'gpt-4o-mini' });
    expect(completeCalls[0]!.model).toBe('gpt-4o-mini');
  });

  it('model 缺省：回落 llms 第一个 provider 的第一个 model', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok')]);
    const llm = channelWith(provider);
    await llm.complete('x');
    expect(completeCalls[0]!.model).toBe('gpt-4o');
  });

  it('model 歧义（多 provider 同名）→ AgentError，不发请求', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok')]);
    const llms = {
      ...defaultLlms(),
      deepseek: { provider: 'openai', apiKey: 'k', models: { 'gpt-4o': {} } },
    };
    const llm = createLightComplete({
      llms,
      providers: new Map([
        ['openai', provider],
        ['deepseek', provider],
      ]),
    });
    await expect(llm.complete('x', { model: 'gpt-4o' })).rejects.toThrow(AgentError);
    expect(completeCalls).toHaveLength(0);
  });

  it('model 不存在于任何 provider → AgentError，不发请求', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok')]);
    const llm = channelWith(provider);
    await expect(llm.complete('x', { model: 'nope' })).rejects.toThrow(AgentError);
    expect(completeCalls).toHaveLength(0);
  });

  it('llms 为空 → AgentError（无 provider 可解析），不发请求', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok')]);
    const llm = createLightComplete({ llms: {}, providers: new Map([['openai', provider]]) });
    await expect(llm.complete('x')).rejects.toThrow(AgentError);
    expect(completeCalls).toHaveLength(0);
  });

  // ─── 超时与重试（request 级覆盖转发） ────────────────────

  it('默认超时 60s：config 无 timeoutMs 时 request.timeoutMs = 60000', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok')]);
    const llm = channelWith(provider);
    await llm.complete('x');
    expect(completeCalls[0]!.timeoutMs).toBe(60_000);
  });

  it('LlmConfig.timeoutMs 作为默认：优先于框架默认 60s', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok')]);
    const llm = createLightComplete({
      llms: { openai: { provider: 'openai', apiKey: 'k', timeoutMs: 5000, models: { m: {} } } },
      providers: new Map([['openai', provider]]),
    });
    await llm.complete('x');
    expect(completeCalls[0]!.timeoutMs).toBe(5000);
  });

  it('options.timeoutMs 最高优先：覆盖 config.timeoutMs', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok')]);
    const llm = createLightComplete({
      llms: { openai: { provider: 'openai', apiKey: 'k', timeoutMs: 5000, models: { m: {} } } },
      providers: new Map([['openai', provider]]),
    });
    await llm.complete('x', { timeoutMs: 1000 });
    expect(completeCalls[0]!.timeoutMs).toBe(1000);
  });

  it('options.maxRetries 转发（未声明时不设——provider 用 config 值）', async () => {
    const { provider, completeCalls } = createMockProvider([llmResponse('ok'), llmResponse('ok')]);
    const llm = channelWith(provider);
    await llm.complete('x');
    expect(completeCalls[0]!.maxRetries).toBeUndefined();
    await llm.complete('x', { maxRetries: 0 });
    expect(completeCalls[1]!.maxRetries).toBe(0);
  });

  // ─── 失败语义（可降级不可静默） ─────────────────────────

  it('传输失败：无 fallback → 原样抛 LLMProviderError', async () => {
    const err = new LLMProviderError('HTTP 502: bad gateway', { status: 502 });
    const { provider } = createMockProvider([err]);
    const llm = channelWith(provider);
    await expect(llm.complete('x')).rejects.toBe(err);
  });

  it('传输失败：声明 fallback → 返回降级值 + console.warn 兜底留痕（无 onFailure 时）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new LLMProviderError('HTTP 502: bad gateway', { status: 502 });
    const { provider } = createMockProvider([err]);
    const llm = channelWith(provider);
    await expect(llm.complete('x', { fallback: 'uncategorized' })).resolves.toBe('uncategorized');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('502');
  });

  it('传输失败：声明 onFailure → 收到 (err, attempts) 后错误照抛', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onFailure = vi.fn();
    const err = new LLMProviderError('HTTP 503', { status: 503 });
    err.attempts = 3; // 模拟 provider 重试耗尽回填（openai.test.ts 覆盖回填本身）
    const { provider } = createMockProvider([err]);
    const llm = channelWith(provider);
    await expect(llm.complete('x', { onFailure })).rejects.toBe(err);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(err, { attempts: 3 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('fallback + onFailure 组合：降级生效，留痕走钩子（不再重复 warn）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onFailure = vi.fn();
    const err = new LLMProviderError('HTTP 500', { status: 500 });
    const { provider } = createMockProvider([err]);
    const llm = channelWith(provider);
    await expect(llm.complete('x', { fallback: '', onFailure })).resolves.toBe('');
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('响应无 attempts 时 onFailure 的 info.attempts = 1', async () => {
    const onFailure = vi.fn();
    const err = new LLMProviderError('boom', { status: 500 });
    const { provider } = createMockProvider([err]);
    const llm = channelWith(provider);
    await expect(llm.complete('x', { onFailure })).rejects.toBe(err);
    expect(onFailure).toHaveBeenCalledWith(err, { attempts: 1 });
  });

  it('超时错误分型：LLMTimeoutError 可编程区分（instanceof 链），无 fallback 时照抛', async () => {
    const err = new LLMTimeoutError('LLM request timed out after 1000ms');
    const { provider } = createMockProvider([err]);
    const llm = channelWith(provider);
    try {
      await llm.complete('x');
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBe(err);
      expect(e instanceof LLMTimeoutError).toBe(true);
      expect(e instanceof LLMProviderError).toBe(true);
    }
  });

  it('用户取消（AgentAbortError）：不走 fallback、不触发 onFailure、不 warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onFailure = vi.fn();
    const err = new AgentAbortError();
    const { provider } = createMockProvider([err]);
    const llm = channelWith(provider);
    await expect(llm.complete('x', { fallback: 'fb', onFailure })).rejects.toBe(err);
    expect(onFailure).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // ─── providers 缺省：按 llms 现场构建（worker 重建形态） ─────

  it('providers 缺省：按 llms 构建 OpenAI provider 并真实发请求', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { index: 0, message: { role: 'assistant', content: 'built' }, finish_reason: 'stop' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const llm = createLightComplete({
        llms: {
          openai: {
            provider: 'openai',
            apiKey: 'k',
            baseURL: 'https://gw.test/v1',
            models: { m1: {} },
          },
        },
      });
      await expect(llm.complete('x')).resolves.toBe('built');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://gw.test/v1/chat/completions');
      expect(JSON.parse(String(init.body)).model).toBe('m1');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
