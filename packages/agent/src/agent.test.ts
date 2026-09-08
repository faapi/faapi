import { describe, it, expect, vi, afterEach } from 'vitest';
import { Agent, AgentError } from './agent';
import { AgentAbortError } from './provider';
import type { AgentDeps, AgentRuntimeConfig, ToolSchemaResolution } from './agent';
import type {
  AgentCore,
  AgentMetadata,
  FaapiContext,
  LlmConfig,
  ToolMetadata,
  ToolModule,
  AgentModule,
} from '@faapi/faapi';
import type {
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  LLMStopReason,
  LLMUsage,
  LLMMessage,
  LLMToolDefinition,
} from './provider';

// ─── Mock 数据构造器 ─────────────────────────────────

/** 构造 AgentCore（LLM 可见字段,不含 filePath/hasRun/hasConfig） */
function agentMeta(opts: Partial<AgentCore> = {}): AgentCore {
  return {
    name: opts.name ?? 'researcher',
    description: opts.description,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    agents: opts.agents,
    model: opts.model,
    maxTurns: opts.maxTurns,
  };
}

/** 构造 AgentMetadata（AgentCore + filePath/hasRun,无 hasConfig,供 getAgentEntry mock） */
function agentEntry(opts: Partial<AgentMetadata> = {}): AgentMetadata {
  return {
    name: opts.name ?? 'researcher',
    filePath: opts.filePath ?? 'dist/agents/researcher/handler.js',
    hasRun: opts.hasRun ?? false,
    description: opts.description,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    agents: opts.agents,
    model: opts.model,
    maxTurns: opts.maxTurns,
  };
}

/** 构造 ToolMetadata */
function toolMeta(opts: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    name: opts.name ?? 'weather.getWeather',
    functionName: opts.functionName ?? 'getWeather',
    description: opts.description ?? '获取天气',
    inputTypeName: opts.inputTypeName,
    filePath: opts.filePath ?? 'dist/tools/weather/handler.js',
  };
}

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

/** 默认测试用 llms 配置（含 'gpt-4o' / 'gpt-4o-mini' 两个 model,便于 options.model 切换测试） */
function defaultLlms(): Record<string, LlmConfig> {
  return {
    openai: {
      provider: 'openai',
      apiKey: 'test-key',
      models: { 'gpt-4o': {}, 'gpt-4o-mini': {} },
    },
  };
}

/** 构造 AgentDeps（mock 访问器）
 *
 * @param opts.provider 默认测试 provider（放入 providers Map 的 'openai' key 下）
 * @param opts.llms 可选,覆盖默认 llms 配置（用于多 provider 测试）
 * @param opts.extraProviders 可选,额外加入 providers Map 的 provider（key 是 provider 名）
 */
function createDeps(opts: {
  provider: LLMProvider;
  llms?: Record<string, LlmConfig>;
  extraProviders?: Record<string, LLMProvider>;
  agent: AgentCore;
  agentEntry?: AgentMetadata;
  tools?: ToolMetadata[];
  subAgents?: AgentCore[];
  subAgentEntries?: AgentMetadata[];
  config?: AgentRuntimeConfig;
  ctx?: FaapiContext;
  loadToolModuleImpl?: (filePath: string, functionName: string) => Promise<ToolModule>;
  loadAgentModuleImpl?: (filePath: string, hasRun: boolean) => Promise<AgentModule>;
  resolveToolSchemaImpl?: (tool: ToolMetadata) => Promise<ToolSchemaResolution | undefined>;
  getToolImpl?: (name: string) => ToolMetadata | undefined;
}): AgentDeps {
  const toolsByName = new Map<string, ToolMetadata>();
  for (const t of opts.tools ?? []) {
    toolsByName.set(t.name, t);
  }
  const llms = opts.llms ?? defaultLlms();
  const providers = new Map<string, LLMProvider>([['openai', opts.provider]]);
  if (opts.extraProviders) {
    for (const [name, p] of Object.entries(opts.extraProviders)) {
      providers.set(name, p);
    }
  }
  return {
    providers,
    llms,
    rootDir: '/project',
    config: opts.config,
    ctx: opts.ctx,
    getAgent: (name) =>
      name === opts.agent.name ? opts.agent : opts.subAgents?.find((a) => a.name === name),
    getAgentEntry: (name) =>
      name === opts.agent.name
        ? opts.agentEntry
        : opts.subAgentEntries?.find((a) => a.name === name),
    getTool: opts.getToolImpl ?? ((name) => toolsByName.get(name)),
    resolveAgentTools: (name) => (name === opts.agent.name ? (opts.tools ?? []) : []),
    resolveSubAgents: (name) => (name === opts.agent.name ? (opts.subAgents ?? []) : []),
    loadToolModule: async (filePath, functionName) =>
      opts.loadToolModuleImpl
        ? opts.loadToolModuleImpl(filePath, functionName)
        : Promise.reject(new Error(`loadToolModule not mocked for ${filePath}`)),
    loadAgentModule: async (filePath, hasRun) =>
      opts.loadAgentModuleImpl
        ? opts.loadAgentModuleImpl(filePath, hasRun)
        : Promise.reject(new Error(`loadAgentModule not mocked for ${filePath}`)),
    resolveToolSchema: opts.resolveToolSchemaImpl
      ? (tool) => opts.resolveToolSchemaImpl!(tool)
      : undefined,
  };
}

// ─── Agent 类构造 ────────────────────────────────────

describe('Agent', () => {
  describe('run() — 基本流程', () => {
    it('组装 config 调 reactLoop,返回最终结果', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'Hello!', stopReason: 'stop' }),
      ]);
      const agent = new Agent(
        createDeps({
          provider,
          // meta.model 作为缺省 key 参与 llms 解析（defaultLlms 的 openai.models 里已声明）
          agent: agentMeta({ systemPrompt: 'You are helpful', model: 'gpt-4o', maxTurns: 5 }),
          tools: [toolMeta()],
        }),
      );

      const result = await agent.run('hi', { agent: 'researcher' });

      expect(result.content).toBe('Hello!');
      expect(result.turns).toBe(1);

      // 验证 provider 收到 systemPrompt + model + tools
      const request = completeCalls.mock.calls[0][0];
      expect(request.messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
      expect(request.model).toBe('gpt-4o');
      expect(request.tools).toHaveLength(1);
      expect(request.tools[0].name).toBe('weather.getWeather');
    });

    it('maxTurns 优先级:agent 元数据 > 全局 config', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({ maxTurns: 7 }),
          config: { maxTurns: 20 },
        }),
      );

      await agent.run('hi', { agent: 'researcher', model: 'gpt-4o' });

      // agent.maxTurns=7,全局 20,应取 7。单轮直答无法直接断言 maxTurns,
      // 但可通过让 LLM 连续 tool_call 验证 7 轮后抛 ReactLoopError——此处简化为验证单轮直答不抛错
      expect(completeCalls).toHaveBeenCalledTimes(1);
    });
  });

  describe('run() — agent 未注册', () => {
    it('抛 AgentError', async () => {
      const { provider } = createMockProvider([]);
      const deps = createDeps({ provider, agent: agentMeta() });
      // 让 getAgent 返回 undefined
      deps.getAgent = () => undefined;

      const agent = new Agent(deps);

      await expect(agent.run('hi', { agent: 'researcher' })).rejects.toThrowError(AgentError);
    });
  });

  describe('executeTool — 常规 tool 路由', () => {
    it('loadToolModule 加载 handler 并调用,返回结果', async () => {
      const handler = vi.fn(async (args: Record<string, unknown>) => ({
        city: args.city,
        temp: 25,
      }));
      const { provider } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'weather.getWeather', arguments: { city: '北京' } }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'done', stopReason: 'stop' }),
      ]);
      const loadToolModuleImpl = vi.fn(
        async (filePath: string, functionName: string): Promise<ToolModule> => {
          expect(filePath).toBe('dist/tools/weather/handler.js');
          expect(functionName).toBe('getWeather');
          return { handler: handler as (...args: unknown[]) => unknown, functionName };
        },
      );

      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
          tools: [toolMeta()],
          loadToolModuleImpl,
        }),
      );

      const result = await agent.run('weather?', { agent: 'researcher', model: 'gpt-4o' });
      expect(result.content).toBe('done');
      // handler 签名 (args, ctx)：编程式直调无 ctx 时第二参数为 undefined
      expect(handler).toHaveBeenCalledWith({ city: '北京' }, undefined);
    });

    it('tool 未找到时抛错,被 reactLoop catch 后回传 LLM', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'missing.tool', arguments: {} }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'recovered', stopReason: 'stop' }),
      ]);

      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
          tools: [], // 不含 missing.tool
        }),
      );

      const result = await agent.run('hi', { agent: 'researcher', model: 'gpt-4o' });
      // 第二轮 LLM 收到 tool 错误消息后给出最终回答
      expect(result.content).toBe('recovered');

      // 验证第二轮请求的 messages 含 tool 角色消息（错误回传）
      const secondRequest = completeCalls.mock.calls[1][0];
      const toolMsg = secondRequest.messages.find((m: LLMMessage) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toMatch(/missing\.tool|not found|Tool/i);
    });

    it('未声明的已注册 tool 被白名单拒绝（防 LLM 幻觉/提示注入越权执行）', async () => {
      const adminHandler = vi.fn(async () => ({ dropped: true }));
      const { provider, completeCalls } = createMockProvider([
        llmResponse({
          // LLM 幻觉：调用了已注册但该 agent 未声明的管理类 tool
          toolCalls: [{ id: 'c1', name: 'admin.dropAll', arguments: {} }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'refused', stopReason: 'stop' }),
      ]);

      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
          // agent 只声明了 weather.getWeather
          tools: [toolMeta()],
          // 但注册表里还存在 admin.dropAll——未声明时也应拒绝执行
          getToolImpl: (name) =>
            name === 'admin.dropAll'
              ? {
                  name: 'admin.dropAll',
                  description: 'dangerous',
                  filePath: 'dist/tools/admin/handler.js',
                  functionName: 'dropAll',
                }
              : undefined,
          loadToolModuleImpl: async () => ({
            handler: adminHandler as (...args: unknown[]) => unknown,
            functionName: 'dropAll',
          }),
        }),
      );

      const result = await agent.run('hi', { agent: 'researcher', model: 'gpt-4o' });
      expect(result.content).toBe('refused');

      // 危险 handler 绝不能被执行
      expect(adminHandler).not.toHaveBeenCalled();

      // LLM 收到的是"未声明"错误（可自纠），不是执行结果
      const secondRequest = completeCalls.mock.calls[1][0];
      const toolMsg = secondRequest.messages.find((m: LLMMessage) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(String(toolMsg!.content)).toContain('not declared by agent');
    });

    it('未声明的 sub-agent 被白名单拒绝', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'agent.hallucinated', arguments: {} }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'refused', stopReason: 'stop' }),
      ]);

      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
          tools: [],
          subAgents: [], // 未声明任何 sub-agent
        }),
      );

      const result = await agent.run('hi', { agent: 'researcher', model: 'gpt-4o' });
      expect(result.content).toBe('refused');
      const secondRequest = completeCalls.mock.calls[1][0];
      const toolMsg = secondRequest.messages.find((m: LLMMessage) => m.role === 'tool');
      expect(String(toolMsg!.content)).toContain('not declared by agent');
    });
  });

  describe('executeTool — input 校验', () => {
    it('resolveToolSchema.validate 失败时返回 { error },不调用 handler', async () => {
      const handler = vi.fn(async () => 'should not be called');
      const validate = vi.fn((): { ok: false; error: string } => ({
        ok: false,
        error: 'city is required',
      }));
      const { provider, completeCalls } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'weather.getWeather', arguments: {} }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'retry with city', stopReason: 'stop' }),
      ]);

      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
          tools: [toolMeta()],
          loadToolModuleImpl: async (filePath, functionName) => ({
            handler: handler as (...args: unknown[]) => unknown,
            functionName,
          }),
          resolveToolSchemaImpl: async () => ({
            jsonSchema: { type: 'object', properties: { city: { type: 'string' } } },
            validate,
          }),
        }),
      );

      await agent.run('weather?', { agent: 'researcher', model: 'gpt-4o' });

      expect(validate).toHaveBeenCalledWith({});
      expect(handler).not.toHaveBeenCalled();

      // 校验错误回传 LLM
      const secondRequest = completeCalls.mock.calls[1][0];
      const toolMsg = secondRequest.messages.find((m: LLMMessage) => m.role === 'tool');
      expect(toolMsg!.content).toMatch(/city is required/);
    });

    it('校验通过时用 coerce 后的 value 调用 handler', async () => {
      const handler = vi.fn(async (args: Record<string, unknown>) => ({
        ok: true,
        city: args.city,
      }));
      const { provider } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'weather.getWeather', arguments: { city: '北京' } }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'done', stopReason: 'stop' }),
      ]);

      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
          tools: [toolMeta()],
          loadToolModuleImpl: async (filePath, functionName) => ({
            handler: handler as (...args: unknown[]) => unknown,
            functionName,
          }),
          resolveToolSchemaImpl: async () => ({
            jsonSchema: { type: 'object' },
            validate: (): { ok: true; value: Record<string, unknown> } => ({
              ok: true,
              value: { city: '北京' },
            }),
          }),
        }),
      );

      await agent.run('weather?', { agent: 'researcher', model: 'gpt-4o' });
      expect(handler).toHaveBeenCalledWith({ city: '北京' }, undefined);
    });

    it('resolveToolSchema 对同一 tool 只调用一次（schema 缓存）', async () => {
      const handler = vi.fn(async (args: Record<string, unknown>) => ({
        ok: true,
        city: args.city,
      }));
      const resolveToolSchemaImpl = vi.fn(async () => ({
        jsonSchema: { type: 'object', properties: { city: { type: 'string' } } },
        validate: (
          input: Record<string, unknown>,
        ): { ok: true; value: Record<string, unknown> } => ({ ok: true, value: input }),
      }));
      const { provider } = createMockProvider([
        // 第一轮：LLM 请求调用 weather tool
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'weather.getWeather', arguments: { city: '北京' } }],
          stopReason: 'tool_calls',
        }),
        // 第二轮：LLM 再次请求调用同一 tool
        llmResponse({
          toolCalls: [{ id: 'c2', name: 'weather.getWeather', arguments: { city: '上海' } }],
          stopReason: 'tool_calls',
        }),
        // 第三轮：最终答案
        llmResponse({ content: 'done', stopReason: 'stop' }),
      ]);

      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
          tools: [toolMeta()],
          loadToolModuleImpl: async (filePath, functionName) => ({
            handler: handler as (...args: unknown[]) => unknown,
            functionName,
          }),
          resolveToolSchemaImpl,
        }),
      );

      await agent.run('weather?', { agent: 'researcher', model: 'gpt-4o' });

      // buildToolDefinitions 调用 1 次,两次 executeTool 命中缓存——总共只调用 1 次
      expect(resolveToolSchemaImpl).toHaveBeenCalledTimes(1);
      // handler 两次 tool_call 都执行
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('executeTool — sub-agent 递归', () => {
    it('sub-agent 有 hasRun 时调自定义 run,结果回传父 LLM', async () => {
      // 父 provider:第一轮请求 agent.writer → 收 sub 结果 → 最终答案
      const { provider: parentProvider, completeCalls: parentCalls } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'agent.writer', arguments: { topic: 'AI' } }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'final', stopReason: 'stop' }),
      ]);

      // getAgent 返回 AgentCore（LLM-facing 字段）;getAgentEntry 返回 AgentMetadata（含 filePath/hasRun）
      const writerCore = agentMeta({ name: 'writer' });
      const writerEntryMeta = agentEntry({
        name: 'writer',
        filePath: 'dist/agents/writer/handler.js',
        hasRun: true,
      });
      const researcherMeta = agentMeta({ name: 'researcher', agents: ['writer'] });

      const agent = new Agent(
        createDeps({
          provider: parentProvider,
          agent: researcherMeta,
          subAgents: [writerCore],
          subAgentEntries: [writerEntryMeta],
          loadAgentModuleImpl: async (filePath, _hasRun) => {
            if (filePath.includes('writer')) {
              return {
                run: (async (args: unknown) => `drafted: ${JSON.stringify(args)}`) as (
                  ...args: unknown[]
                ) => unknown,
              };
            }
            throw new Error(`unexpected loadAgentModule for ${filePath}`);
          },
        }),
      );

      const result = await agent.run('write about AI', {
        agent: 'researcher',
        model: 'gpt-4o',
      });
      expect(result.content).toBe('final');

      // 验证第二轮请求把 sub-agent 结果回传 LLM
      const secondRequest = parentCalls.mock.calls[1][0];
      const toolMsg = secondRequest.messages.find((m: LLMMessage) => m.role === 'tool');
      expect(toolMsg!.content).toMatch(/drafted/);
    });

    it('sub-agent 无 hasRun 时走默认 reactLoop,stringify args 作为 input', async () => {
      // 父 provider 需与子不同——DI 复用父 provider 会冲突
      // 解决:deps.provider 是父的;子 agent 构造时复用同 deps.provider
      // 为隔离,让父 provider 的 mock 序列中预留子 agent 的调用
      const { provider: parentProvider, completeCalls } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'agent.writer', arguments: { topic: 'AI' } }],
          stopReason: 'tool_calls',
        }),
        // 子 agent.run 调 provider.complete 第二次,返回 sub-answer
        llmResponse({ content: 'sub-answer', stopReason: 'stop' }),
        // 父收 sub 结果后最终答案
        llmResponse({ content: 'parent-final', stopReason: 'stop' }),
      ]);

      // getAgentEntry 返回 hasRun: false → 跳过自定义 run,走默认 reactLoop
      const writerCore = agentMeta({ name: 'writer' });
      const writerEntryMeta = agentEntry({ name: 'writer', hasRun: false });
      const researcherMeta = agentMeta({ name: 'researcher', agents: ['writer'] });

      const agent = new Agent(
        createDeps({
          provider: parentProvider,
          agent: researcherMeta,
          subAgents: [writerCore],
          subAgentEntries: [writerEntryMeta],
          loadAgentModuleImpl: async () => ({ run: undefined }),
        }),
      );

      const result = await agent.run('write about AI', {
        agent: 'researcher',
        model: 'gpt-4o',
      });
      expect(result.content).toBe('parent-final');

      // 验证子 agent 的 input 是 stringify(args)
      const childRequest = completeCalls.mock.calls[1][0];
      expect(childRequest.messages.find((m: LLMMessage) => m.role === 'user')!.content).toBe(
        JSON.stringify({ topic: 'AI' }),
      );
    });
  });

  describe('maxAgentDepth 防护', () => {
    it('超出 maxAgentDepth 抛 AgentRecursionError,被 reactLoop catch 回传 LLM', async () => {
      // depth=3, maxAgentDepth=3 → 子 agent depth=4 > 3 抛错
      const { provider, completeCalls } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'agent.writer', arguments: {} }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'recovered from recursion error', stopReason: 'stop' }),
      ]);

      const writerMeta = agentMeta({ name: 'writer' });
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({ name: 'researcher', agents: ['writer'] }),
          subAgents: [writerMeta],
          config: { maxAgentDepth: 1 }, // 根 depth=1, 子 depth=2 > 1 抛错
          loadAgentModuleImpl: async () => ({ run: undefined }),
        }),
      );

      const result = await agent.run('hi', { agent: 'researcher', model: 'gpt-4o' });
      expect(result.content).toBe('recovered from recursion error');

      // 验证错误回传 LLM
      const secondRequest = completeCalls.mock.calls[1][0];
      const toolMsg = secondRequest.messages.find((m: LLMMessage) => m.role === 'tool');
      expect(toolMsg!.content).toMatch(/depth|recursion|maxAgentDepth/i);
    });

    it('depth 未超限时正常递归', async () => {
      const { provider } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'agent.writer', arguments: { q: 'x' } }],
          stopReason: 'tool_calls',
        }),
        // 子 agent.run 调用
        llmResponse({ content: 'sub-ok', stopReason: 'stop' }),
        // 父最终答案
        llmResponse({ content: 'parent-ok', stopReason: 'stop' }),
      ]);

      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({ name: 'researcher', agents: ['writer'] }),
          subAgents: [agentMeta({ name: 'writer' })],
          config: { maxAgentDepth: 3 }, // 根1 → 子2,未超限
          loadAgentModuleImpl: async () => ({ run: undefined }),
        }),
      );

      const result = await agent.run('hi', { agent: 'researcher', model: 'gpt-4o' });
      expect(result.content).toBe('parent-ok');
    });
  });

  describe('buildToolDefinitions — tool 列表组装', () => {
    it('合并 resolveAgentTools + sub-agents,去重', async () => {
      const sharedTool = toolMeta({ name: 'shared.ping', functionName: 'ping' });
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);

      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({
            name: 'researcher',
            agents: ['writer'],
          }),
          tools: [sharedTool],
          subAgents: [agentMeta({ name: 'writer', description: '写作 agent' })],
          getToolImpl: (name) => (name === 'shared.ping' ? sharedTool : undefined),
        }),
      );

      await agent.run('hi', { agent: 'researcher', model: 'gpt-4o' });

      const request = completeCalls.mock.calls[0][0];
      const toolNames = (request.tools as LLMToolDefinition[]).map((t) => t.name);
      expect(toolNames).toContain('shared.ping');
      expect(toolNames).toContain('agent.writer');
      // 无 defaultTools,只有 resolveAgentTools + sub-agent
      expect(toolNames).toHaveLength(2);
    });

    it('resolveToolSchema 提供 jsonSchema,未提供时用 { type: object }', async () => {
      const withSchema = toolMeta({ name: 'with.schema', inputTypeName: 'Input' });
      const noSchema = toolMeta({ name: 'no.schema', inputTypeName: undefined });
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);

      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
          tools: [withSchema, noSchema],
          resolveToolSchemaImpl: async (tool) => {
            if (tool.inputTypeName === 'Input') {
              return {
                jsonSchema: { type: 'object', properties: { q: { type: 'string' } } },
                validate: (): { ok: true; value: Record<string, unknown> } => ({
                  ok: true,
                  value: {},
                }),
              };
            }
            return undefined;
          },
        }),
      );

      await agent.run('hi', { agent: 'researcher', model: 'gpt-4o' });

      const tools = completeCalls.mock.calls[0][0].tools as LLMToolDefinition[];
      const withDef = tools.find((t) => t.name === 'with.schema')!;
      const noDef = tools.find((t) => t.name === 'no.schema')!;
      expect(withDef.input).toEqual({ type: 'object', properties: { q: { type: 'string' } } });
      expect(noDef.input).toEqual({ type: 'object' });
    });

    it('sub-agent 包装为 agent.<name>,input 为自由 schema', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);

      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({ name: 'researcher', agents: ['writer'] }),
          subAgents: [agentMeta({ name: 'writer', description: '写作' })],
        }),
      );

      await agent.run('hi', { agent: 'researcher', model: 'gpt-4o' });

      const tools = completeCalls.mock.calls[0][0].tools as LLMToolDefinition[];
      const writerDef = tools.find((t) => t.name === 'agent.writer')!;
      expect(writerDef.description).toBe('写作');
      expect(writerDef.input).toEqual({ type: 'object' });
    });
  });

  describe('asTool()', () => {
    it('返回 AgentToolDescriptor,含 agent. 前缀名', () => {
      const { provider } = createMockProvider([]);
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({ name: 'researcher', description: '研究 agent' }),
        }),
      );

      const desc = agent.asTool('researcher');
      expect(desc).toBeDefined();
      expect(desc!.kind).toBe('agent');
      expect(desc!.name).toBe('agent.researcher');
      expect(desc!.agentName).toBe('researcher');
      expect(desc!.description).toBe('研究 agent');
      expect(desc!.metadata.name).toBe('researcher');
    });

    it('agent 未注册时返回 undefined', () => {
      const { provider } = createMockProvider([]);
      const deps = createDeps({ provider, agent: agentMeta() });
      deps.getAgent = () => undefined;

      const agent = new Agent(deps);
      expect(agent.asTool('researcher')).toBeUndefined();
    });
  });

  describe('stream()', () => {
    it('委托给 reactLoopStream,yield chunks', async () => {
      const { provider } = createMockStreamProvider([
        [{ deltaContent: 'Hello' }, { deltaContent: ' world' }, { finishReason: 'stop' }],
      ]);

      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
        }),
      );

      const chunks = await collect(agent.stream('hi', { agent: 'researcher', model: 'gpt-4o' }));
      const deltas = chunks.filter((c) => c.deltaContent !== undefined);
      expect(deltas.map((c) => c.deltaContent).join('')).toBe('Hello world');
      const done = chunks.find((c) => c.done !== undefined);
      expect(done!.done!.content).toBe('Hello world');
    });
  });

  describe('depth 传递', () => {
    it('根 Agent depth 默认为 1', () => {
      const { provider } = createMockProvider([]);
      const agent = new Agent(createDeps({ provider, agent: agentMeta() }));
      // depth 是私有的,通过 maxAgentDepth 行为间接验证(见 maxAgentDepth 用例)
      expect(agent).toBeDefined();
    });
  });

  describe('run() / stream() — options 覆盖', () => {
    it('options.model 覆盖 agent 元数据 model', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({ model: 'gpt-4o' }),
        }),
      );

      await agent.run('hi', { agent: 'researcher', model: 'gpt-4o-mini' });

      const request = completeCalls.mock.calls[0][0];
      expect(request.model).toBe('gpt-4o-mini');
    });

    it('未传 options.model 时用 agent 元数据 model 作为缺省 key 解析', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({ model: 'gpt-4o' }),
        }),
      );

      await agent.run('hi', { agent: 'researcher' });

      const request = completeCalls.mock.calls[0][0];
      expect(request.model).toBe('gpt-4o');
    });

    it('options.model 与 agent 元数据 model 均缺省且无 options.provider 时抛 AgentError', async () => {
      const { provider } = createMockProvider([llmResponse({ content: 'ok', stopReason: 'stop' })]);
      const agent = new Agent(createDeps({ provider, agent: agentMeta() }));

      await expect(agent.run('hi', { agent: 'researcher' })).rejects.toThrowError(AgentError);
    });

    it('options.model 用 llms key 切换 provider（不调默认 provider）', async () => {
      const overrideCalls = vi.fn();
      const overrideProvider: LLMProvider = {
        complete: async () => {
          overrideCalls();
          return {
            message: { role: 'assistant', content: 'from-override' },
            stopReason: 'stop' as LLMStopReason,
            usage: undefined,
          };
        },
        stream: () => {
          throw new Error('stream not mocked');
        },
      };
      const { provider: defaultProvider, completeCalls: defaultCalls } = createMockProvider([
        llmResponse({ content: 'from-default', stopReason: 'stop' }),
      ]);

      // 双 provider llms:openai(默认) + anthropic(覆盖)
      const llms: Record<string, LlmConfig> = {
        openai: { provider: 'openai', apiKey: 'k1', models: { 'gpt-4o': {} } },
        anthropic: { provider: 'anthropic', apiKey: 'k2', models: { 'claude-3': {} } },
      };

      const agent = new Agent(
        createDeps({
          provider: defaultProvider,
          llms,
          extraProviders: { anthropic: overrideProvider },
          agent: agentMeta(),
        }),
      );

      // model='anthropic' 精确匹配 llms key → 切到 anthropic provider
      const result = await agent.run('hi', { agent: 'researcher', model: 'anthropic' });

      expect(result.content).toBe('from-override');
      expect(overrideCalls).toHaveBeenCalledTimes(1);
      expect(defaultCalls).not.toHaveBeenCalled();
    });

    it('options.model 用 provider/model 一体化形式切换', async () => {
      const overrideCalls = vi.fn();
      const overrideProvider: LLMProvider = {
        complete: async (req) => {
          overrideCalls(req);
          return {
            message: { role: 'assistant', content: 'from-anthropic' },
            stopReason: 'stop' as LLMStopReason,
            usage: undefined,
          };
        },
        stream: () => {
          throw new Error('stream not mocked');
        },
      };
      const { provider: defaultProvider } = createMockProvider([
        llmResponse({ content: 'from-default', stopReason: 'stop' }),
      ]);

      const llms: Record<string, LlmConfig> = {
        openai: { provider: 'openai', apiKey: 'k1', models: { 'gpt-4o': {} } },
        anthropic: { provider: 'anthropic', apiKey: 'k2', models: { 'claude-3': {} } },
      };

      const agent = new Agent(
        createDeps({
          provider: defaultProvider,
          llms,
          extraProviders: { anthropic: overrideProvider },
          agent: agentMeta(),
        }),
      );

      // 'anthropic/claude-3' → 拆 [anthropic, claude-3],切到 anthropic provider + claude-3 model
      const result = await agent.run('hi', { agent: 'researcher', model: 'anthropic/claude-3' });

      expect(result.content).toBe('from-anthropic');
      const request = overrideCalls.mock.calls[0][0];
      expect(request.model).toBe('claude-3');
    });

    it('options.model 用纯 model 名切换（在 llms 里唯一匹配）', async () => {
      const overrideCalls = vi.fn();
      const overrideProvider: LLMProvider = {
        complete: async () => {
          overrideCalls();
          return {
            message: { role: 'assistant', content: 'from-anthropic' },
            stopReason: 'stop' as LLMStopReason,
            usage: undefined,
          };
        },
        stream: () => {
          throw new Error('stream not mocked');
        },
      };
      const { provider: defaultProvider } = createMockProvider([
        llmResponse({ content: 'from-default', stopReason: 'stop' }),
      ]);

      const llms: Record<string, LlmConfig> = {
        openai: { provider: 'openai', apiKey: 'k1', models: { 'gpt-4o': {} } },
        anthropic: { provider: 'anthropic', apiKey: 'k2', models: { 'claude-3-sonnet': {} } },
      };

      const agent = new Agent(
        createDeps({
          provider: defaultProvider,
          llms,
          extraProviders: { anthropic: overrideProvider },
          agent: agentMeta(),
        }),
      );

      // 'claude-3-sonnet' 在 anthropic.models 里唯一 → 切到 anthropic provider + 该 model
      const result = await agent.run('hi', { agent: 'researcher', model: 'claude-3-sonnet' });

      expect(result.content).toBe('from-anthropic');
      expect(overrideCalls).toHaveBeenCalledTimes(1);
    });

    it('options.model 纯 model 名在多 provider 歧义时抛 AgentError', async () => {
      const { provider: defaultProvider } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);
      // 'gpt-4o' 同时在 openai 和 anthropic 的 models 里 → 歧义
      const llms: Record<string, LlmConfig> = {
        openai: { provider: 'openai', apiKey: 'k1', models: { 'gpt-4o': {} } },
        anthropic: { provider: 'anthropic', apiKey: 'k2', models: { 'gpt-4o': {} } },
      };
      const overrideProvider: LLMProvider = {
        complete: async () => ({ message: { role: 'assistant', content: '' }, stopReason: 'stop' }),
        stream: () => {
          throw new Error('not mocked');
        },
      };

      const agent = new Agent(
        createDeps({
          provider: defaultProvider,
          llms,
          extraProviders: { anthropic: overrideProvider },
          agent: agentMeta(),
        }),
      );

      await expect(agent.run('hi', { agent: 'researcher', model: 'gpt-4o' })).rejects.toThrowError(
        AgentError,
      );
    });

    it('options.model 未声明的 provider/model 抛 AgentError', async () => {
      const { provider: defaultProvider } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);

      const agent = new Agent(
        createDeps({
          provider: defaultProvider,
          agent: agentMeta(),
        }),
      );

      // 'unknown-llm/gpt-x' 的 provider 不在 llms 里
      await expect(
        agent.run('hi', { agent: 'researcher', model: 'unknown-llm/gpt-x' }),
      ).rejects.toThrowError(AgentError);
      // 'unknown-model' 纯 model 名,不在任何 provider 的 models 里
      await expect(
        agent.run('hi', { agent: 'researcher', model: 'unknown-model' }),
      ).rejects.toThrowError(AgentError);
    });

    it('options.temperature / maxTokens 透传给 provider', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
        }),
      );

      await agent.run('hi', {
        agent: 'researcher',
        model: 'gpt-4o',
        temperature: 0.1,
        maxTokens: 50,
      });

      const request = completeCalls.mock.calls[0][0];
      expect(request.temperature).toBe(0.1);
      expect(request.maxTokens).toBe(50);
    });

    it('stream 也支持 options 覆盖 model', async () => {
      const { provider, streamCalls } = createMockStreamProvider([
        [{ deltaContent: 'x' }, { finishReason: 'stop' }],
      ]);
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({ model: 'gpt-4' }),
        }),
      );

      await collect(agent.stream('hi', { agent: 'researcher', model: 'gpt-4o-mini' }));

      const request = streamCalls.mock.calls[0][0];
      expect(request.model).toBe('gpt-4o-mini');
    });

    it('options 不修改 agent 状态（下一次 run 仍用元数据 model 解析）', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'first', stopReason: 'stop' }),
        llmResponse({ content: 'second', stopReason: 'stop' }),
      ]);
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({ model: 'gpt-4o' }),
        }),
      );

      await agent.run('hi', { agent: 'researcher', model: 'gpt-4o-mini' });
      await agent.run('hi', { agent: 'researcher' });

      const firstRequest = completeCalls.mock.calls[0][0];
      const secondRequest = completeCalls.mock.calls[1][0];
      expect(firstRequest.model).toBe('gpt-4o-mini');
      expect(secondRequest.model).toBe('gpt-4o');
    });

    it('options.agent 覆盖 agent 名（使用指定 agent 的元数据/tools）', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);
      const researcherMeta = agentMeta({
        name: 'researcher',
        systemPrompt: 'You are a researcher.',
      });
      const writerMeta = agentMeta({ name: 'writer', systemPrompt: 'You are a writer.' });

      const agent = new Agent(
        createDeps({
          provider,
          agent: researcherMeta,
          subAgents: [writerMeta],
        }),
      );

      await agent.run('hi', { agent: 'writer', model: 'gpt-4o' });

      const request = completeCalls.mock.calls[0][0];
      expect(request.messages[0]).toEqual({ role: 'system', content: 'You are a writer.' });
    });

    it('stream 也支持 options.agent 覆盖 agent 名', async () => {
      const { provider, streamCalls } = createMockStreamProvider([
        [{ deltaContent: 'x' }, { finishReason: 'stop' }],
      ]);
      const researcherMeta = agentMeta({
        name: 'researcher',
        systemPrompt: 'You are a researcher.',
      });
      const writerMeta = agentMeta({ name: 'writer', systemPrompt: 'You are a writer.' });

      const agent = new Agent(
        createDeps({
          provider,
          agent: researcherMeta,
          subAgents: [writerMeta],
        }),
      );

      await collect(agent.stream('hi', { agent: 'writer', model: 'gpt-4o' }));

      const request = streamCalls.mock.calls[0][0];
      expect(request.messages[0]).toEqual({ role: 'system', content: 'You are a writer.' });
    });

    it('不传 options.agent 时抛 AgentError（无默认 agent——每次调用显式指定）', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);
      const researcherMeta = agentMeta({
        name: 'researcher',
        systemPrompt: 'You are a researcher.',
      });

      const agent = new Agent(createDeps({ provider, agent: researcherMeta }));

      await expect(agent.run('hi')).rejects.toThrowError(/options\.agent/);
      await expect(agent.run('hi', { model: 'gpt-4o' })).rejects.toThrowError(/options\.agent/);
      expect(completeCalls).not.toHaveBeenCalled();
    });
  });

  describe('run() / stream() — options.provider 外部 provider', () => {
    /** 构造 OpenAI chat completions JSON 响应 Response（外部 provider LlmConfig 形式测试用） */
    function jsonResponse(payload: unknown): Response {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('LlmConfig 形式：现场创建 provider,请求打到外部 baseURL 且带上 apiKey', async () => {
      const { provider: defaultProvider, completeCalls: defaultCalls } = createMockProvider([
        llmResponse({ content: 'from-default', stopReason: 'stop' }),
      ]);
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            { message: { role: 'assistant', content: 'from-external' }, finish_reason: 'stop' },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const agent = new Agent(
        createDeps({ provider: defaultProvider, agent: agentMeta({ model: 'gpt-4' }) }),
      );

      const result = await agent.run('hi', {
        agent: 'researcher',
        provider: {
          provider: 'openai',
          apiKey: 'user-key',
          baseURL: 'https://byok.example.com/v1',
          models: { 'gpt-4o': {} },
          temperature: 0.7,
        },
        model: 'gpt-4o',
      });

      // 走外部 provider,默认 provider 未被调用
      expect(result.content).toBe('from-external');
      expect(defaultCalls).not.toHaveBeenCalled();

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://byok.example.com/v1/chat/completions');
      expect(init.headers.Authorization).toBe('Bearer user-key');
      const body = JSON.parse(init.body);
      // options.model 为原始 model 名（agent 元数据 model 'gpt-4' 不泄漏）
      expect(body.model).toBe('gpt-4o');
      // LlmConfig 的 provider 级透传字段生效
      expect(body.temperature).toBe(0.7);
    });

    it('LLMProvider 实例形式：直接使用,model 带 / 原样透传不解析', async () => {
      const externalCalls = vi.fn();
      const externalProvider: LLMProvider = {
        complete: async (req) => {
          externalCalls(req);
          return {
            message: { role: 'assistant', content: 'from-gateway' },
            stopReason: 'stop' as LLMStopReason,
          };
        },
        stream: () => {
          throw new Error('stream not mocked');
        },
      };
      const { provider: defaultProvider, completeCalls: defaultCalls } = createMockProvider([
        llmResponse({ content: 'from-default', stopReason: 'stop' }),
      ]);

      const agent = new Agent(
        createDeps({ provider: defaultProvider, agent: agentMeta({ model: 'gpt-4' }) }),
      );

      const result = await agent.run('hi', {
        agent: 'researcher',
        provider: externalProvider,
        model: 'anthropic/claude-3.5-sonnet',
      });

      expect(result.content).toBe('from-gateway');
      expect(defaultCalls).not.toHaveBeenCalled();
      expect(externalCalls).toHaveBeenCalledTimes(1);
      const request = externalCalls.mock.calls[0][0];
      // 带 / 的 model id 不做 provider/model 拆分,原样透传
      expect(request.model).toBe('anthropic/claude-3.5-sonnet');
    });

    it('options.provider 优先级最高：llms 里已声明的 model key 也走外部 provider', async () => {
      const externalCalls = vi.fn();
      const externalProvider: LLMProvider = {
        complete: async (req) => {
          externalCalls(req);
          return {
            message: { role: 'assistant', content: 'from-external' },
            stopReason: 'stop' as LLMStopReason,
          };
        },
        stream: () => {
          throw new Error('stream not mocked');
        },
      };
      const llmsAnthropicCalls = vi.fn();
      const llmsAnthropicProvider: LLMProvider = {
        complete: async () => {
          llmsAnthropicCalls();
          return {
            message: { role: 'assistant', content: 'from-llms-anthropic' },
            stopReason: 'stop' as LLMStopReason,
          };
        },
        stream: () => {
          throw new Error('stream not mocked');
        },
      };
      const { provider: defaultProvider, completeCalls: defaultCalls } = createMockProvider([
        llmResponse({ content: 'from-default', stopReason: 'stop' }),
      ]);

      // llms 里 openai（默认）+ anthropic（'claude-3' 已声明）
      const llms: Record<string, LlmConfig> = {
        openai: { provider: 'openai', apiKey: 'k1', models: { 'gpt-4o': {} } },
        anthropic: { provider: 'anthropic', apiKey: 'k2', models: { 'claude-3': {} } },
      };

      const agent = new Agent(
        createDeps({
          provider: defaultProvider,
          llms,
          extraProviders: { anthropic: llmsAnthropicProvider },
          agent: agentMeta(),
        }),
      );

      // 'claude-3' 在 llms 的 anthropic.models 里,但外部 provider 存在时 llms 完全被忽略
      const result = await agent.run('hi', {
        agent: 'researcher',
        provider: externalProvider,
        model: 'claude-3',
      });

      expect(result.content).toBe('from-external');
      expect(externalCalls).toHaveBeenCalledTimes(1);
      expect(defaultCalls).not.toHaveBeenCalled();
      expect(llmsAnthropicCalls).not.toHaveBeenCalled();
      expect(externalCalls.mock.calls[0][0].model).toBe('claude-3');
    });

    it('LlmConfig 形式缺省 options.model 时回落 models 第一个 key', async () => {
      const { provider: defaultProvider } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const agent = new Agent(
        createDeps({ provider: defaultProvider, agent: agentMeta({ model: 'gpt-4' }) }),
      );

      await agent.run('hi', {
        agent: 'researcher',
        provider: { provider: 'openai', apiKey: 'k', models: { 'gateway-model': {} } },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // agent 元数据 model 'gpt-4' 不泄漏到外部 provider
      expect(body.model).toBe('gateway-model');
    });

    it('LlmConfig 形式缺省 options.model 且 models 为空时抛 AgentError', async () => {
      const { provider } = createMockProvider([llmResponse({ content: 'ok', stopReason: 'stop' })]);
      const agent = new Agent(createDeps({ provider, agent: agentMeta() }));

      await expect(
        agent.run('hi', {
          agent: 'researcher',
          provider: { provider: 'openai', apiKey: 'k', models: {} },
        }),
      ).rejects.toThrowError(AgentError);
    });

    it('provider 形式非法（既非 LlmConfig 也非 LLMProvider）抛 AgentError', async () => {
      const { provider } = createMockProvider([llmResponse({ content: 'ok', stopReason: 'stop' })]);
      const agent = new Agent(createDeps({ provider, agent: agentMeta() }));

      // 普通对象缺 provider 字段
      await expect(
        agent.run('hi', { agent: 'researcher', provider: { foo: 'bar' } as unknown as LlmConfig }),
      ).rejects.toThrowError(AgentError);
      // 字符串不是合法形式
      await expect(
        agent.run('hi', { agent: 'researcher', provider: 'openai' as unknown as LlmConfig }),
      ).rejects.toThrowError(AgentError);
    });

    it('外部 provider 仅本次调用生效,下一次 run 走 llms 解析的 provider', async () => {
      const externalCalls = vi.fn();
      const externalProvider: LLMProvider = {
        complete: async () => {
          externalCalls();
          return {
            message: { role: 'assistant', content: 'from-external' },
            stopReason: 'stop' as LLMStopReason,
          };
        },
        stream: () => {
          throw new Error('stream not mocked');
        },
      };
      const { provider: defaultProvider, completeCalls: defaultCalls } = createMockProvider([
        llmResponse({ content: 'from-default', stopReason: 'stop' }),
      ]);

      const agent = new Agent(
        createDeps({ provider: defaultProvider, agent: agentMeta({ model: 'gpt-4o' }) }),
      );

      const first = await agent.run('hi', {
        agent: 'researcher',
        provider: externalProvider,
        model: 'm1',
      });
      // 第二次不传外部 provider——meta.model 作为缺省 key 走 llms 解析（openai）
      const second = await agent.run('hi', { agent: 'researcher' });

      expect(first.content).toBe('from-external');
      expect(second.content).toBe('from-default');
      expect(externalCalls).toHaveBeenCalledTimes(1);
      expect(defaultCalls).toHaveBeenCalledTimes(1);
    });

    it('sub-agent 递归继承父调用的 provider（含外部 provider）,model 用 sub 元数据声明', async () => {
      const externalCalls = vi.fn();
      let externalTurn = 0;
      const externalProvider: LLMProvider = {
        complete: async (req) => {
          externalCalls(req);
          // turn 1：父请求调 sub-agent；turn 2：sub-agent 直答；turn 3：父给出最终回答
          externalTurn++;
          if (externalTurn === 1) {
            return {
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'agent.writer', arguments: { task: 'write' } }],
              },
              stopReason: 'tool_calls' as LLMStopReason,
            };
          }
          if (externalTurn === 2) {
            return {
              message: { role: 'assistant', content: 'sub-done' },
              stopReason: 'stop' as LLMStopReason,
            };
          }
          return {
            message: { role: 'assistant', content: 'parent-done' },
            stopReason: 'stop' as LLMStopReason,
          };
        },
        stream: () => {
          throw new Error('stream not mocked');
        },
      };
      // llms 里的 openai provider 不应被调用——父走外部 provider,sub 继承之
      const { provider: defaultProvider, completeCalls: defaultCalls } = createMockProvider([
        llmResponse({ content: 'never called', stopReason: 'stop' }),
      ]);

      const agent = new Agent(
        createDeps({
          provider: defaultProvider,
          agent: agentMeta({ name: 'researcher' }),
          subAgents: [agentMeta({ name: 'writer' })], // writer 元数据无 model
        }),
      );

      const result = await agent.run('hi', {
        agent: 'researcher',
        provider: externalProvider,
        model: 'ext-model',
      });

      expect(result.content).toBe('parent-done');
      // 父两轮 + sub 一轮都走同一个外部 provider（继承）
      expect(externalCalls).toHaveBeenCalledTimes(3);
      expect(externalCalls.mock.calls[0][0].model).toBe('ext-model');
      // sub-agent 未声明 model 时沿用父 model（ext-model）
      expect(externalCalls.mock.calls[1][0].model).toBe('ext-model');
      // llms 解析的 provider 全程未被调用
      expect(defaultCalls).not.toHaveBeenCalled();
    });

    it('sub-agent 元数据声明 model 时优先用自身 model（继承父 provider）', async () => {
      const parentCalls = vi.fn();
      const parentProvider: LLMProvider = {
        complete: async (req) => {
          parentCalls(req);
          const turn = parentCalls.mock.calls.length;
          if (turn === 1) {
            return {
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'agent.writer', arguments: { task: 'write' } }],
              },
              stopReason: 'tool_calls' as LLMStopReason,
            };
          }
          if (turn === 2) {
            return {
              message: { role: 'assistant', content: 'sub-done' },
              stopReason: 'stop' as LLMStopReason,
            };
          }
          return {
            message: { role: 'assistant', content: 'parent-done' },
            stopReason: 'stop' as LLMStopReason,
          };
        },
        stream: () => {
          throw new Error('stream not mocked');
        },
      };

      const agent = new Agent(
        createDeps({
          provider: parentProvider,
          agent: agentMeta({ name: 'researcher' }),
          subAgents: [agentMeta({ name: 'writer', model: 'gpt-4o-mini' })],
        }),
      );

      const result = await agent.run('hi', { agent: 'researcher', model: 'gpt-4o' });

      expect(result.content).toBe('parent-done');
      // turn 2 是 sub-agent 的调用——provider 继承父,model 用 sub 元数据声明的 gpt-4o-mini
      const subRequest = parentCalls.mock.calls[1][0];
      expect(subRequest.model).toBe('gpt-4o-mini');
    });

    it('stream 也支持外部 provider', async () => {
      const streamCalls = vi.fn();
      const externalProvider: LLMProvider = {
        complete: async () => {
          throw new Error('complete not mocked');
        },
        stream: async function* (req) {
          streamCalls(req);
          yield { deltaContent: 'hello ' };
          yield { deltaContent: 'stream', finishReason: 'stop' as LLMStopReason };
        },
      };
      const { provider: defaultProvider } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);

      const agent = new Agent(createDeps({ provider: defaultProvider, agent: agentMeta() }));

      const chunks = await collect(
        agent.stream('hi', { agent: 'researcher', provider: externalProvider }),
      );

      const deltas = chunks.filter((c) => c.deltaContent !== undefined);
      expect(deltas.map((c) => c.deltaContent).join('')).toBe('hello stream');
      expect(streamCalls).toHaveBeenCalledTimes(1);
    });

    describe('无 provider 可解析（llms 未配置,外部 provider 模式）', () => {
      /** 构造空 providers 的 AgentDeps（config.agent.llms 未配置时插件注入的形态） */
      function createDepsWithoutProvider(): AgentDeps {
        return {
          providers: new Map(),
          llms: {},
          rootDir: '/project',
          getAgent: (name) => (name === 'researcher' ? agentMeta() : undefined),
          getAgentEntry: () => undefined,
          getTool: () => undefined,
          resolveAgentTools: () => [],
          resolveSubAgents: () => [],
          loadToolModule: async () => {
            throw new Error('loadToolModule not mocked');
          },
          loadAgentModule: async () => {
            throw new Error('loadAgentModule not mocked');
          },
        };
      }

      it('不传 options.provider/model 时抛 AgentError（提示配置 llms 或传外部 provider）', async () => {
        const agent = new Agent(createDepsWithoutProvider());

        await expect(agent.run('hi', { agent: 'researcher' })).rejects.toThrowError(
          /options\.provider/,
        );
      });

      it('options.model 纯 model 名在空 llms 下抛 AgentError 且提示外部 provider', async () => {
        const agent = new Agent(createDepsWithoutProvider());

        await expect(
          agent.run('hi', { agent: 'researcher', model: 'gpt-4o' }),
        ).rejects.toThrowError(/options\.provider/);
      });

      it('传 options.provider（LLMProvider 实例）时正常执行（纯外部 provider 项目）', async () => {
        const externalCalls = vi.fn();
        const externalProvider: LLMProvider = {
          complete: async (req) => {
            externalCalls(req);
            return {
              message: { role: 'assistant', content: 'ok-byok' },
              stopReason: 'stop' as LLMStopReason,
            };
          },
          stream: () => {
            throw new Error('stream not mocked');
          },
        };
        const agent = new Agent(createDepsWithoutProvider());

        const result = await agent.run('hi', {
          agent: 'researcher',
          provider: externalProvider,
          model: 'm1',
        });

        expect(result.content).toBe('ok-byok');
        expect(externalCalls).toHaveBeenCalledTimes(1);
      });
    });
  });

  it('run(options.signal) 透传到 provider.complete 的请求参数', async () => {
    const { provider, completeCalls } = createMockProvider([
      llmResponse({ content: 'ok', stopReason: 'stop' }),
    ]);
    const agent = new Agent(createDeps({ provider, agent: agentMeta() }));

    const controller = new AbortController();
    await agent.run('hi', { agent: 'researcher', model: 'gpt-4o', signal: controller.signal });

    const request = completeCalls.mock.calls[0][0];
    expect(request.signal).toBe(controller.signal);
  });

  describe('鉴权钩子（authHooks）', () => {
    const ctx = {
      method: 'POST',
      path: '/api/agent',
      user: { id: 1 },
      workspace: { id: 'ws-1' },
    } as unknown as FaapiContext;

    function toolCallProvider() {
      return createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'weather.getWeather', arguments: { city: '北京' } }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'done', stopReason: 'stop' }),
      ]);
    }

    it('beforeToolCall 放行（void）: handler 正常执行且收到 ctx', async () => {
      const handler = vi.fn(async () => ({ ok: true }));
      const { provider } = toolCallProvider();
      const beforeToolCall = vi.fn(() => undefined);
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
          tools: [toolMeta()],
          loadToolModuleImpl: async () => ({
            handler: handler as (...args: unknown[]) => unknown,
            functionName: 'getWeather',
          }),
          config: { beforeToolCall },
          ctx,
        }),
      );

      await agent.run('weather?', { agent: 'researcher', model: 'gpt-4o' });
      expect(beforeToolCall).toHaveBeenCalledWith('weather.getWeather', { city: '北京' }, ctx);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('beforeToolCall 拒绝: handler 不执行,{ error } 回传 LLM', async () => {
      const handler = vi.fn(async () => ({ ok: true }));
      const { provider, completeCalls } = toolCallProvider();
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
          tools: [toolMeta()],
          loadToolModuleImpl: async () => ({
            handler: handler as (...args: unknown[]) => unknown,
            functionName: 'getWeather',
          }),
          config: {
            beforeToolCall: () => ({ error: 'workspace context required' }),
          },
          ctx,
        }),
      );

      await agent.run('weather?', { agent: 'researcher', model: 'gpt-4o' });
      expect(handler).not.toHaveBeenCalled();
      const secondRequest = completeCalls.mock.calls[1][0];
      const toolMsg = secondRequest.messages.find((m: LLMMessage) => m.role === 'tool');
      expect(JSON.stringify(toolMsg?.content)).toContain('workspace context required');
    });

    it('beforeToolCall 改写: handler 收到改写后的 args + ctx 第二参数', async () => {
      const handler = vi.fn(async () => ({ ok: true }));
      const { provider } = toolCallProvider();
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
          tools: [toolMeta()],
          loadToolModuleImpl: async () => ({
            handler: handler as (...args: unknown[]) => unknown,
            functionName: 'getWeather',
          }),
          config: {
            beforeToolCall: (_name, args) => ({ args: { ...args, workspaceId: 'ws-1' } }),
          },
          ctx,
        }),
      );

      await agent.run('weather?', { agent: 'researcher', model: 'gpt-4o' });
      expect(handler).toHaveBeenCalledWith({ city: '北京', workspaceId: 'ws-1' }, ctx);
    });

    it('beforeToolCall 对 sub-agent 递归（agent.x）同样拦截,拒绝时 mod.run 不执行', async () => {
      const subRun = vi.fn(async () => 'sub result');
      const { provider, completeCalls } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'agent.analyst', arguments: { q: 'x' } }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'done', stopReason: 'stop' }),
      ]);
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({ agents: ['analyst'] }),
          subAgents: [agentMeta({ name: 'analyst' })],
          subAgentEntries: [
            {
              ...agentMeta({ name: 'analyst' }),
              filePath: 'dist/agents/analyst/handler.js',
              hasRun: true,
            } as AgentMetadata,
          ],
          loadAgentModuleImpl: async () => ({ run: subRun }) as unknown as AgentModule,
          config: {
            beforeToolCall: (name) =>
              name.startsWith('agent.') ? { error: 'sub-agent not allowed' } : undefined,
          },
          ctx,
        }),
      );

      await agent.run('go', { agent: 'researcher', model: 'gpt-4o' });
      expect(subRun).not.toHaveBeenCalled();
      const secondRequest = completeCalls.mock.calls[1][0];
      const toolMsg = secondRequest.messages.find((m: LLMMessage) => m.role === 'tool');
      expect(JSON.stringify(toolMsg?.content)).toContain('sub-agent not allowed');
    });

    it('ctx 传递: sub-agent 自定义 run 收到 ctx 第二参数', async () => {
      const subRun = vi.fn(async () => 'sub result');
      const { provider, completeCalls } = createMockProvider([
        llmResponse({
          toolCalls: [{ id: 'c1', name: 'agent.analyst', arguments: { q: 'x' } }],
          stopReason: 'tool_calls',
        }),
        llmResponse({ content: 'done', stopReason: 'stop' }),
      ]);
      void completeCalls;
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({ agents: ['analyst'] }),
          subAgents: [agentMeta({ name: 'analyst' })],
          subAgentEntries: [
            {
              ...agentMeta({ name: 'analyst' }),
              filePath: 'dist/agents/analyst/handler.js',
              hasRun: true,
            } as AgentMetadata,
          ],
          loadAgentModuleImpl: async () => ({ run: subRun }) as unknown as AgentModule,
          ctx,
        }),
      );

      await agent.run('go', { agent: 'researcher', model: 'gpt-4o' });
      expect(subRun).toHaveBeenCalledWith({ q: 'x' }, ctx);
    });

    it('afterToolCall 成功后调用（name, args, result, ctx),拒绝时不调用', async () => {
      const handler = vi.fn(async () => ({ ok: true, temp: 25 }));
      const afterToolCall = vi.fn();

      // 拒绝场景：afterToolCall 不调用
      const { provider: deniedProvider } = toolCallProvider();
      const denied = new Agent(
        createDeps({
          provider: deniedProvider,
          agent: agentMeta(),
          tools: [toolMeta()],
          loadToolModuleImpl: async () => ({
            handler: handler as (...args: unknown[]) => unknown,
            functionName: 'getWeather',
          }),
          config: {
            beforeToolCall: () => ({ error: 'denied' }),
            afterToolCall,
          },
          ctx,
        }),
      );
      await denied.run('weather?', { agent: 'researcher', model: 'gpt-4o' });
      expect(afterToolCall).not.toHaveBeenCalled();

      // 放行场景：成功后调用
      const { provider } = toolCallProvider();
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
          tools: [toolMeta()],
          loadToolModuleImpl: async () => ({
            handler: handler as (...args: unknown[]) => unknown,
            functionName: 'getWeather',
          }),
          config: { afterToolCall },
          ctx,
        }),
      );
      await agent.run('weather?', { agent: 'researcher', model: 'gpt-4o' });
      expect(afterToolCall).toHaveBeenCalledWith(
        'weather.getWeather',
        { city: '北京' },
        { ok: true, temp: 25 },
        ctx,
      );
    });

    it('filterTools 过滤 LLM 可见 tools 清单（含 agent-as-tool）', async () => {
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'done', stopReason: 'stop' }),
      ]);
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({ agents: ['analyst'] }),
          tools: [toolMeta(), toolMeta({ name: 'admin.deleteUser', functionName: 'deleteUser' })],
          subAgents: [agentMeta({ name: 'analyst' })],
          config: {
            filterTools: (tools) => tools.filter((t) => !t.name.startsWith('admin.')),
          },
          ctx,
        }),
      );

      await agent.run('hi', { agent: 'researcher', model: 'gpt-4o' });
      const request = completeCalls.mock.calls[0][0];
      const names = request.tools.map((t: { name: string }) => t.name);
      expect(names).toContain('weather.getWeather');
      expect(names).toContain('agent.analyst');
      expect(names).not.toContain('admin.deleteUser');
    });

    it('钩子未配置时行为不变: tool 正常执行,ctx 仍传给 handler', async () => {
      const handler = vi.fn(async () => ({ ok: true }));
      const { provider } = toolCallProvider();
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta(),
          tools: [toolMeta()],
          loadToolModuleImpl: async () => ({
            handler: handler as (...args: unknown[]) => unknown,
            functionName: 'getWeather',
          }),
          ctx,
        }),
      );

      await agent.run('weather?', { agent: 'researcher', model: 'gpt-4o' });
      expect(handler).toHaveBeenCalledWith({ city: '北京' }, ctx);
    });
  });
});

// ─── 中断恢复（Resume）──────────────────────────────

describe('Agent — 中断恢复（Resume）', () => {
  /** 合法续跑历史：system + user + 完整轮组 */
  const resumeHistory: LLMMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 't1', arguments: {} }],
    },
    { role: 'tool', content: 'r1', toolCallId: 'c1' },
  ];

  it('run(undefined, { messages }) 纯续跑：provider 收到完整历史', async () => {
    const { provider, completeCalls } = createMockProvider([
      llmResponse({ content: 'resumed', stopReason: 'stop' }),
    ]);
    const agent = new Agent(createDeps({ provider, agent: agentMeta({ systemPrompt: 'sys' }) }));

    const result = await agent.run(undefined, {
      agent: 'researcher',
      model: 'gpt-4o',
      messages: resumeHistory,
    });

    expect(result.content).toBe('resumed');
    expect(completeCalls.mock.calls[0][0].messages).toEqual(resumeHistory);
  });

  it('run() 无 input 且无 messages → 抛 AgentError，不发起 LLM 请求', async () => {
    const { provider, completeCalls } = createMockProvider([
      llmResponse({ content: 'x', stopReason: 'stop' }),
    ]);
    const agent = new Agent(createDeps({ provider, agent: agentMeta() }));

    await expect(agent.run()).rejects.toBeInstanceOf(AgentError);
    await expect(agent.run(undefined, {})).rejects.toBeInstanceOf(AgentError);
    expect(completeCalls).not.toHaveBeenCalled();
  });

  it("run('') 空 input 且无 messages → 抛 AgentError", async () => {
    const { provider, completeCalls } = createMockProvider([
      llmResponse({ content: 'x', stopReason: 'stop' }),
    ]);
    const agent = new Agent(createDeps({ provider, agent: agentMeta() }));

    await expect(agent.run('')).rejects.toBeInstanceOf(AgentError);
    expect(completeCalls).not.toHaveBeenCalled();
  });

  it("run('继续', { messages }) → 历史末尾追加 user 消息（多轮对话）", async () => {
    const { provider, completeCalls } = createMockProvider([
      llmResponse({ content: 'ok', stopReason: 'stop' }),
    ]);
    const agent = new Agent(createDeps({ provider, agent: agentMeta({ systemPrompt: 'sys' }) }));

    await agent.run('继续', {
      agent: 'researcher',
      model: 'gpt-4o',
      messages: resumeHistory,
    });

    const sent = completeCalls.mock.calls[0][0].messages;
    expect(sent.slice(0, -1)).toEqual(resumeHistory);
    expect(sent.at(-1)).toEqual({ role: 'user', content: '继续' });
  });

  it('stream(undefined, { messages }) 同样支持续跑', async () => {
    const { provider, streamCalls } = createMockStreamProvider([
      [{ deltaContent: 'resumed', finishReason: 'stop' }],
    ]);
    const agent = new Agent(createDeps({ provider, agent: agentMeta({ systemPrompt: 'sys' }) }));

    const chunks = await collect(
      agent.stream(undefined, {
        agent: 'researcher',
        model: 'gpt-4o',
        messages: resumeHistory,
      }),
    );

    expect(chunks.at(-1)?.done).toMatchObject({ content: 'resumed', stopReason: 'stop' });
    expect(streamCalls.mock.calls[0][0].messages).toEqual(resumeHistory);
  });

  it('options.messages 结构非法（tool 结果缺失）→ 抛 AgentError，不发起 LLM 请求', async () => {
    const { provider, completeCalls } = createMockProvider([
      llmResponse({ content: 'x', stopReason: 'stop' }),
    ]);
    const agent = new Agent(createDeps({ provider, agent: agentMeta() }));
    const broken: LLMMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 't1', arguments: {} }],
      },
      // 缺 tool 结果（截断在轮组中间）
    ];

    const err = await agent.run(undefined, { messages: broken }).catch((e) => e);

    expect(err).toBeInstanceOf(AgentError);
    expect(String(err.message)).toContain('c1');
    expect(completeCalls).not.toHaveBeenCalled();
  });

  it('options.messages 含未知 role → 抛 AgentError', async () => {
    const { provider, completeCalls } = createMockProvider([
      llmResponse({ content: 'x', stopReason: 'stop' }),
    ]);
    const agent = new Agent(createDeps({ provider, agent: agentMeta() }));
    const broken = [
      { role: 'robot', content: 'hi' }, // 反序列化出的非法 role
    ] as unknown as LLMMessage[];

    const err = await agent.run(undefined, { messages: broken }).catch((e) => e);

    expect(err).toBeInstanceOf(AgentError);
    expect(String(err.message)).toContain('robot');
    expect(completeCalls).not.toHaveBeenCalled();
  });

  it('中断恢复全流程：abort 携带断点历史 → 用 err.messages 续跑完成', async () => {
    const controller = new AbortController();
    const { provider } = createMockProvider([
      llmResponse({
        toolCalls: [{ id: 'c1', name: 'weather.getWeather', arguments: { city: '北京' } }],
        stopReason: 'tool_calls',
      }),
      llmResponse({ content: 'never reached' }),
    ]);
    const agent = new Agent(
      createDeps({
        provider,
        agent: agentMeta(),
        tools: [toolMeta()],
        loadToolModuleImpl: async () => ({
          handler: async () => {
            controller.abort(); // 模拟 tool 执行期间客户端断开
            return '晴';
          },
          functionName: 'getWeather',
        }),
      }),
    );

    const err = await agent
      .run('北京天气?', { agent: 'researcher', model: 'gpt-4o', signal: controller.signal })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AgentAbortError);
    // 断点历史：完整轮组（assistant.toolCalls + tool 结果配对）
    expect(err.messages.map((m: LLMMessage) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(err.messages[2]).toEqual({ role: 'tool', content: '晴', toolCallId: 'c1' });

    // 续跑：新一次 run，无新输入，从断点历史继续
    const { provider: provider2, completeCalls } = createMockProvider([
      llmResponse({ content: '北京今天晴', stopReason: 'stop' }),
    ]);
    const agent2 = new Agent(
      createDeps({ provider: provider2, agent: agentMeta({ systemPrompt: 'sys' }) }),
    );

    const result = await agent2.run(undefined, {
      agent: 'researcher',
      model: 'gpt-4o',
      messages: err.messages,
    });

    expect(result.content).toBe('北京今天晴');
    expect(result.turns).toBe(1); // 续跑轮数重新计数
    const sent = completeCalls.mock.calls[0][0].messages;
    expect(sent.at(-1)).toEqual({ role: 'tool', content: '晴', toolCallId: 'c1' });
  });
});
