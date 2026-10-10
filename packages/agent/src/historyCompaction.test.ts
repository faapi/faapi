import { describe, it, expect, vi } from 'vitest';
import { assertCompactedHistory, type HistoryCompactorInput } from './historyCompaction';
import { AgentError } from './agentErrors';
import { AgentError as AgentErrorFromAgent } from './agent';
import { reactLoop, reactLoopStream } from './reactLoop';
import { Agent } from './agent';
import type {
  LLMProvider,
  LLMResponse,
  LLMMessage,
  LLMToolCall,
  LLMStopReason,
  LLMStreamChunk,
} from './provider';
import type { AgentCore, AgentMetadata } from '@faapi/faapi';
import type { AgentDeps, AgentRuntimeConfig } from './agent';

// ─── Mock 工具（同 reactLoop.test.ts 形制）──────────────

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): LLMToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function llmResponse(opts: {
  content?: string;
  toolCalls?: LLMToolCall[];
  stopReason?: LLMStopReason;
}): LLMResponse {
  const message: LLMMessage = { role: 'assistant', content: opts.content ?? '' };
  if (opts.toolCalls && opts.toolCalls.length > 0) {
    message.tool_calls = opts.toolCalls;
  }
  return {
    message,
    stopReason: opts.stopReason ?? (opts.toolCalls ? 'tool_calls' : 'stop'),
  };
}

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

// ─── assertCompactedHistory（不变量守卫）──────────────

/** 原始历史：system + 初始 user + 两个轮组 */
const ORIGINAL: LLMMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'goal' },
  { role: 'assistant', content: '', tool_calls: [toolCall('c1', 't1')] },
  { role: 'tool', tool_call_id: 'c1', content: 'r1' },
  { role: 'assistant', content: 'mid' },
  { role: 'assistant', content: 'final' },
];

describe('assertCompactedHistory — 输出不变量守卫', () => {
  it('合法输出（丢最旧轮组 + 注入摘要轮）原样放行', () => {
    const compacted: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'goal' },
      { role: 'user', content: '[摘要] 早期对话已完成 t1' },
      { role: 'assistant', content: 'final' },
    ];
    expect(assertCompactedHistory(ORIGINAL, compacted)).toBe(compacted);
  });

  it('头部段被丢弃 → AgentError（用户目标不丢）', () => {
    const compacted: LLMMessage[] = [{ role: 'assistant', content: 'final' }];
    expect(() => assertCompactedHistory(ORIGINAL, compacted)).toThrow(AgentError);
    expect(() => assertCompactedHistory(ORIGINAL, compacted)).toThrow(/head segment/);
  });

  it('头部段内容被改写 → AgentError', () => {
    const compacted: LLMMessage[] = [
      { role: 'system', content: 'sys(改写)' },
      { role: 'user', content: 'goal' },
      { role: 'assistant', content: 'final' },
    ];
    expect(() => assertCompactedHistory(ORIGINAL, compacted)).toThrow(/head segment/);
  });

  it('头部段乱序 → AgentError（system 必须在最前）', () => {
    const compacted: LLMMessage[] = [
      { role: 'user', content: 'goal' },
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'final' },
    ];
    expect(() => assertCompactedHistory(ORIGINAL, compacted)).toThrow(/head segment/);
  });

  it('头部段克隆（非原引用但内容一致）放行——保留语义按内容判定', () => {
    const compacted: LLMMessage[] = [
      { ...ORIGINAL[0]! },
      { ...ORIGINAL[1]! },
      { role: 'assistant', content: 'final' },
    ];
    expect(() => assertCompactedHistory(ORIGINAL, compacted)).not.toThrow();
  });

  it('tool 结果缺失（裁半轮）→ AgentError', () => {
    const compacted: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'goal' },
      { role: 'assistant', content: '', tool_calls: [toolCall('c1', 't1')] },
      { role: 'assistant', content: 'final' },
    ];
    expect(() => assertCompactedHistory(ORIGINAL, compacted)).toThrow(/tool pairing/);
  });

  it('孤立 tool 消息（前一条 assistant 未调用该 tool）→ AgentError', () => {
    const compacted: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'goal' },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'assistant', content: 'final' },
    ];
    expect(() => assertCompactedHistory(ORIGINAL, compacted)).toThrow(/orphan tool/);
  });

  it('空历史（无任何轮组）→ AgentError（不发送空历史）', () => {
    const compacted: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'goal' },
    ];
    expect(() => assertCompactedHistory(ORIGINAL, compacted)).toThrow(/at least one turn group/);
  });

  it('抛的是 AgentError（与 agent.ts 导出同一类，业务 instanceof 可判定）', () => {
    const compacted: LLMMessage[] = [{ role: 'assistant', content: 'x' }];
    try {
      assertCompactedHistory(ORIGINAL, compacted);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AgentErrorFromAgent);
    }
  });
});

// ─── reactLoop × historyCompactor（策略位接线）────────

describe('reactLoop — historyCompactor 策略位', () => {
  it('超预算时调用策略：发送副本为压缩结果，本地 result.messages 不受影响', async () => {
    const compact = vi.fn(
      ({ messages }: HistoryCompactorInput) =>
        [
          messages[0]!, // system
          messages[1]!, // 初始 user
          { role: 'assistant', content: 'summary-of-earlier' },
        ] as LLMMessage[],
    );
    const { provider, completeCalls } = createMockProvider([
      llmResponse({ toolCalls: [toolCall('c1', 't1')], stopReason: 'tool_calls' }),
      llmResponse({ toolCalls: [toolCall('c2', 't2')], stopReason: 'tool_calls' }),
      llmResponse({ content: 'done', stopReason: 'stop' }),
    ]);

    const result = await reactLoop('go', {
      provider,
      systemPrompt: 'sys',
      executeTool: async () => 'r'.repeat(200),
      maxHistoryTokens: 120,
      historyCompactor: compact,
    });

    // 第三轮请求 = 压缩结果（head + 摘要轮）
    const last = completeCalls.mock.calls[2][0].messages;
    expect(last.map((m: LLMMessage) => m.content)).toEqual(['sys', 'go', 'summary-of-earlier']);
    // 入参契约：完整发送候选 + 框架估算值 + 预算
    const input = compact.mock.calls[0][0];
    expect(input.budget).toBe(120);
    expect(typeof input.estimatedTokens).toBe('number');
    expect(input.estimatedTokens).toBeGreaterThan(120);
    expect(input.messages[0]!.role).toBe('system');
    expect(input.messages[1]!.content).toBe('go');
    // 每轮超预算都调用（第 2、3 轮）；本地历史完整（3 条 assistant）
    expect(compact).toHaveBeenCalledTimes(2);
    expect(result.messages.filter((m) => m.role === 'assistant')).toHaveLength(3);
  });

  it('未超预算不调用策略（不打扰正常路径）', async () => {
    const compact = vi.fn();
    const { provider } = createMockProvider([llmResponse({ content: 'done', stopReason: 'stop' })]);
    await reactLoop('go', {
      provider,
      executeTool: async () => '',
      maxHistoryTokens: 1_000_000,
      historyCompactor: compact,
    });
    expect(compact).not.toHaveBeenCalled();
  });

  it('超预算但无轮组（无 assistant）不调用策略，消息原样发送', async () => {
    const compact = vi.fn();
    const { provider, completeCalls } = createMockProvider([
      llmResponse({ content: 'done', stopReason: 'stop' }),
    ]);
    await reactLoop('长输入'.repeat(500), {
      provider,
      executeTool: async () => '',
      maxHistoryTokens: 10,
      historyCompactor: compact,
    });
    expect(compact).not.toHaveBeenCalled();
    const first = completeCalls.mock.calls[0][0].messages;
    expect(first).toHaveLength(1); // 原样发送（与现行 trimHistory 的 no-op 语义一致）
  });

  it('未声明策略回落现行截断（缺省=现状）', async () => {
    const { provider, completeCalls } = createMockProvider([
      llmResponse({ toolCalls: [toolCall('c1', 't1')], stopReason: 'tool_calls' }),
      llmResponse({ toolCalls: [toolCall('c2', 't2')], stopReason: 'tool_calls' }),
      llmResponse({ content: 'done', stopReason: 'stop' }),
    ]);
    await reactLoop('go', {
      provider,
      systemPrompt: 'sys',
      executeTool: async () => 'r'.repeat(200),
      maxHistoryTokens: 120,
    });
    const third = completeCalls.mock.calls[2][0].messages;
    expect(third.some((m: LLMMessage) => m.tool_call_id === 'c1')).toBe(false);
    expect(third.some((m: LLMMessage) => m.tool_call_id === 'c2')).toBe(true);
  });

  it('策略输出违反不变量 → AgentError 冒泡出循环', async () => {
    const { provider } = createMockProvider([
      llmResponse({ toolCalls: [toolCall('c1', 't1')], stopReason: 'tool_calls' }),
      llmResponse({ content: 'never', stopReason: 'stop' }),
    ]);
    await expect(
      reactLoop('go', {
        provider,
        systemPrompt: 'sys',
        executeTool: async () => 'r'.repeat(200),
        maxHistoryTokens: 120,
        historyCompactor: () => [{ role: 'assistant', content: 'head lost' }],
      }),
    ).rejects.toThrow(AgentError);
  });

  it('流式循环同样执行策略', async () => {
    const compact = vi.fn(
      ({ messages }: HistoryCompactorInput) =>
        [
          messages[0]!,
          messages[1]!,
          { role: 'assistant', content: 'summary-of-earlier' },
        ] as LLMMessage[],
    );
    const { provider, streamCalls } = createMockStreamProvider([
      [{ toolCalls: [toolCall('c1', 't1')], finishReason: 'tool_calls' }],
      [{ toolCalls: [toolCall('c2', 't2')], finishReason: 'tool_calls' }],
      [{ deltaContent: 'done', finishReason: 'stop' }],
    ]);

    for await (const _chunk of reactLoopStream('go', {
      provider,
      systemPrompt: 'sys',
      executeTool: async () => 'r'.repeat(200),
      maxHistoryTokens: 120,
      historyCompactor: compact,
    })) {
      void _chunk;
    }

    const third = streamCalls.mock.calls[2][0].messages;
    expect(third.map((m: LLMMessage) => m.content)).toEqual(['sys', 'go', 'summary-of-earlier']);
  });
});

// ─── 子代理传导（AgentRuntimeConfig → deps 全树）──────

describe('historyCompactor 子代理传导', () => {
  it('策略对派发的 sub 同样生效（共享根 deps，与现行裁剪同款传导）', async () => {
    // 序列：父派发 writer → 子第一轮调不存在的 tool（错误回传）→ 子第二轮
    // 触发压缩（子 system 很大 + 预算极小）→ 子返回大结果 → 父终轮同样触发压缩 → 父终答
    const { provider, completeCalls } = createMockProvider([
      llmResponse({
        toolCalls: [toolCall('c1', 'agent-writer', { input: '写' })],
        stopReason: 'tool_calls',
      }),
      llmResponse({ toolCalls: [toolCall('c2', 'nonexistent', {})], stopReason: 'tool_calls' }),
      llmResponse({ content: 'sub-answer'.repeat(60), stopReason: 'stop' }),
      llmResponse({ content: 'parent-final', stopReason: 'stop' }),
    ]);

    // 假 compactor：保头部（sys + 初始 user）+ 最近两条（一个完整轮组）
    const compactor = vi.fn(({ messages }: HistoryCompactorInput) => [
      messages[0]!,
      messages[1]!,
      ...messages.slice(-2),
    ]);
    const subMeta: AgentCore = {
      name: 'writer',
      systemPrompt: 'SUB-SYS-'.repeat(100), // ≈800 字符 ≈ 400 token > 预算
    };
    const subEntry: AgentMetadata = { ...subMeta, filePath: 'dist/agents/writer/handler.js' };

    const config: AgentRuntimeConfig = {
      maxHistoryTokens: 200,
      historyCompactor: compactor,
    };
    const deps: AgentDeps = {
      providers: new Map([['openai', provider]]),
      llms: { openai: { provider: 'openai', apiKey: 'k', models: { 'gpt-4o': {} } } },
      rootDir: '/project',
      config,
      ctx: {},
      getAgent: (name) => (name === 'researcher' ? RESEARCHER : subMeta),
      getAgentEntry: (name) => (name === 'researcher' ? undefined : subEntry),
      getTool: () => undefined,
      resolveAgentTools: () => [],
      resolveSubAgents: (name) => (name === 'researcher' ? [subMeta] : []),
      loadToolModule: async () => {
        throw new Error('not mocked');
      },
      resolveToolSchema: async () => undefined,
      resolveAgentInputSchema: async () => undefined,
      resolveSystemPrompt: undefined,
    };

    const agent = new Agent(deps);
    const result = await agent.run('go', { agent: 'researcher', model: 'gpt-4o' });
    expect(result.content).toBe('parent-final');

    // 子循环第三轮请求（c2 错误回传后）超预算 → 策略被调用，且收到的是子代理历史
    const compactedCalls = compactor.mock.calls.filter((c) =>
      (c[0].messages[0] as LLMMessage).content.startsWith('SUB-SYS-'),
    );
    expect(compactedCalls.length).toBeGreaterThanOrEqual(1);
    // 父循环同受策略管辖（存在以父 system 为头部的调用）
    expect(
      compactor.mock.calls.some((c) => (c[0].messages[0] as LLMMessage).content === 'PARENT-SYS'),
    ).toBe(true);
    // 子代理最终请求经压缩：SUB-SYS 头部保留
    const subLast = completeCalls.mock.calls[2][0].messages;
    expect(subLast[0]!.content).toMatch(/^SUB-SYS-/);
  });
});

const RESEARCHER: AgentCore = {
  name: 'researcher',
  systemPrompt: 'PARENT-SYS',
  agents: ['writer'],
};
