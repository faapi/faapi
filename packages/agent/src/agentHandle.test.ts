import { describe, it, expect } from 'vitest';
import { Agent } from './agent';
import type { AgentHandle, AgentRunOptions } from './agentHandle';
import type { AgentDeps } from './agent';
import type { AgentCore, AgentMetadata, LlmConfig, ToolMetadata } from '@faapi/faapi';
import type {
  LLMCompleteRequest,
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  LLMStopReason,
} from './provider';

// ─── 类型级测试：Agent 满足 AgentHandle ────────────────

/** 编译期断言：Agent 可赋值给 AgentHandle（结构化类型匹配） */
function _assertAgentIsAgentHandle(agent: Agent): AgentHandle {
  return agent;
}

/** 编译期断言：AgentHandle 的方法签名含 options 参数 */
function _assertMethodSignatures(handle: AgentHandle): {
  run: (input: string, options?: AgentRunOptions) => Promise<unknown>;
  stream: (input: string, options?: AgentRunOptions) => AsyncIterable<unknown>;
  asTool: () => unknown;
} {
  return {
    run: handle.run,
    stream: handle.stream,
    asTool: handle.asTool,
  };
}

// ─── 运行时测试 ─────────────────────────────────────

/** 构造 mock provider */
function mockProvider(): LLMProvider {
  return {
    async complete(): Promise<LLMResponse> {
      return {
        message: { role: 'assistant', content: 'done' },
        stopReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async *stream(): AsyncIterable<LLMStreamChunk> {
      yield { deltaContent: 'done' };
      yield { finishReason: 'stop' };
    },
  };
}

/** 默认测试用 llms 配置（含 'gpt-4o' / 'gpt-4o-mini' 两个 model） */
function defaultLlms(): Record<string, LlmConfig> {
  return {
    openai: {
      provider: 'openai',
      apiKey: 'test-key',
      models: { 'gpt-4o': {}, 'gpt-4o-mini': {} },
    },
  };
}

/** 构造完整 AgentDeps（mock 版）
 *
 * @param overrideProvider 可选,覆盖默认 provider 实例（用于多 provider 测试）
 * @param overrideLlms 可选,覆盖默认 llms 配置
 * @param overrideDefaultLlm 可选,覆盖默认 defaultLlm key
 */
function mockDeps(opts?: {
  provider?: LLMProvider;
  llms?: Record<string, LlmConfig>;
  defaultLlm?: string;
}): AgentDeps {
  // getAgent 返回 AgentCore（LLM-facing 字段）;getAgentEntry 返回 AgentMetadata（含 filePath/hasRun）
  const agentCore: AgentCore = {
    name: 'researcher',
    description: '研究 agent',
    systemPrompt: 'you are a researcher',
  };
  const agentEntryMeta: AgentMetadata = {
    ...agentCore,
    filePath: 'dist/agents/researcher/handler.js',
    hasRun: false,
  };
  const provider = opts?.provider ?? mockProvider();
  const llms = opts?.llms ?? defaultLlms();
  const defaultLlm = opts?.defaultLlm ?? 'openai';
  const providers = new Map<string, LLMProvider>([[defaultLlm, provider]]);
  return {
    providers,
    defaultProvider: provider,
    llms,
    defaultLlm,
    agentName: 'researcher',
    rootDir: '/project',
    getAgent: (name) => (name === 'researcher' ? agentCore : undefined),
    getAgentEntry: (name) => (name === 'researcher' ? agentEntryMeta : undefined),
    getTool: () => undefined,
    resolveAgentTools: () => [] as ToolMetadata[],
    resolveSubAgents: () => [] as AgentCore[],
    loadToolModule: async () => ({ handler: async () => 'ok', functionName: 'fn' }),
    loadAgentModule: async () => ({ run: undefined }),
  };
}

describe('AgentHandle', () => {
  describe('类型兼容性', () => {
    it('Agent 实例可赋值给 AgentHandle', () => {
      const agent = new Agent(mockDeps());
      const handle: AgentHandle = agent;
      expect(handle).toBe(agent);
    });

    it('AgentHandle 方法可被调用（签名兼容）', () => {
      const handle: AgentHandle = new Agent(mockDeps());
      expect(typeof handle.run).toBe('function');
      expect(typeof handle.stream).toBe('function');
      expect(typeof handle.asTool).toBe('function');
    });
  });

  describe('run()', () => {
    it('返回 ReactLoopResult（content + turns + stopReason）', async () => {
      const handle: AgentHandle = new Agent(mockDeps());
      const result = await handle.run('hello');
      expect(result.content).toBe('done');
      expect(result.turns).toBe(1);
      expect(result.stopReason).toBe('stop');
    });

    it('agent 未注册时抛 AgentError', async () => {
      const deps = mockDeps();
      deps.getAgent = () => undefined;
      const handle: AgentHandle = new Agent(deps);
      await expect(handle.run('hello')).rejects.toThrow('Agent "researcher" is not registered');
    });

    it('options.model / temperature / maxTokens 透传给 provider', async () => {
      const recorded: LLMCompleteRequest[] = [];
      const recordingProvider: LLMProvider = {
        complete: async (req: LLMCompleteRequest) => {
          recorded.push(req);
          return {
            message: { role: 'assistant', content: 'ok' },
            stopReason: 'stop' as LLMStopReason,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
        stream: () => {
          throw new Error('stream not mocked');
        },
      };
      const deps = mockDeps({ provider: recordingProvider });
      const handle: AgentHandle = new Agent(deps);

      await handle.run('hello', { model: 'gpt-4o-mini', temperature: 0.2, maxTokens: 100 });

      expect(recorded).toHaveLength(1);
      expect(recorded[0].model).toBe('gpt-4o-mini');
      expect(recorded[0].temperature).toBe(0.2);
      expect(recorded[0].maxTokens).toBe(100);
    });

    it('options.model 用 llms key 切换 provider（不调默认 provider）', async () => {
      let overrideCalled = 0;
      let defaultCalled = 0;
      const overrideProvider: LLMProvider = {
        complete: async () => {
          overrideCalled++;
          return {
            message: { role: 'assistant', content: 'override' },
            stopReason: 'stop' as LLMStopReason,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
        stream: () => {
          throw new Error('stream not mocked');
        },
      };
      const defaultProvider: LLMProvider = {
        complete: async () => {
          defaultCalled++;
          return {
            message: { role: 'assistant', content: 'default' },
            stopReason: 'stop' as LLMStopReason,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
        stream: () => {
          throw new Error('stream not mocked');
        },
      };
      // 双 provider llms 配置:openai(默认) + anthropic(覆盖)
      const llms: Record<string, LlmConfig> = {
        openai: { provider: 'openai', apiKey: 'k1', models: { 'gpt-4o': {} } },
        anthropic: { provider: 'anthropic', apiKey: 'k2', models: { 'claude-3': {} } },
      };
      const providers = new Map<string, LLMProvider>([
        ['openai', defaultProvider],
        ['anthropic', overrideProvider],
      ]);
      const deps = mockDeps({
        provider: defaultProvider,
        llms,
        defaultLlm: 'openai',
      });
      // 手动覆盖 providers Map（mockDeps 只放 defaultLlm 一个,这里需要两个）
      deps.providers = providers;
      const handle: AgentHandle = new Agent(deps);

      // model='anthropic' 精确匹配 llms key → 切到 anthropic provider
      const result = await handle.run('hello', { model: 'anthropic' });

      expect(result.content).toBe('override');
      expect(overrideCalled).toBe(1);
      expect(defaultCalled).toBe(0);
    });
  });

  describe('stream()', () => {
    it('yield ReactLoopStreamChunk（delta + done）', async () => {
      const handle: AgentHandle = new Agent(mockDeps());
      const chunks: { deltaContent?: string; done?: { content: string } }[] = [];
      for await (const chunk of handle.stream('hello')) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const done = chunks.find((c) => c.done !== undefined);
      expect(done?.done?.content).toBe('done');
    });
  });

  describe('asTool()', () => {
    it('返回 AgentToolDescriptor（name = agent.<agentName>）', () => {
      const handle: AgentHandle = new Agent(mockDeps());
      const tool = handle.asTool();
      expect(tool).toBeDefined();
      expect(tool?.kind).toBe('agent');
      expect(tool?.name).toBe('agent.researcher');
      expect(tool?.agentName).toBe('researcher');
      expect(tool?.description).toBe('研究 agent');
    });

    it('agent 未注册时返回 undefined', () => {
      const deps = mockDeps();
      deps.getAgent = () => undefined;
      const handle: AgentHandle = new Agent(deps);
      expect(handle.asTool()).toBeUndefined();
    });
  });
});
