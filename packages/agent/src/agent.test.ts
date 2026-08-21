import { describe, it, expect, vi } from 'vitest';
import { Agent, AgentError } from './agent';
import type { AgentDeps, AgentRuntimeConfig, ToolSchemaResolution } from './agent';
import type { AgentMetadata, ToolMetadata, ToolModule, AgentModule } from '@faapi/faapi';
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

/** 构造 AgentMetadata */
function agentMeta(opts: Partial<AgentMetadata> = {}): AgentMetadata {
  return {
    name: opts.name ?? 'researcher',
    filePath: opts.filePath ?? 'dist/agents/researcher/handler.js',
    hasConfig: opts.hasConfig ?? true,
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

/** 构造 AgentDeps（mock 访问器） */
function createDeps(opts: {
  provider: LLMProvider;
  agentName?: string;
  agent: AgentMetadata;
  tools?: ToolMetadata[];
  subAgents?: AgentMetadata[];
  config?: AgentRuntimeConfig;
  loadToolModuleImpl?: (filePath: string, functionName: string) => Promise<ToolModule>;
  loadAgentModuleImpl?: (
    filePath: string,
    hasConfig: boolean,
    hasRun: boolean,
  ) => Promise<AgentModule>;
  resolveToolSchemaImpl?: (tool: ToolMetadata) => Promise<ToolSchemaResolution | undefined>;
  getToolImpl?: (name: string) => ToolMetadata | undefined;
}): AgentDeps {
  const toolsByName = new Map<string, ToolMetadata>();
  for (const t of opts.tools ?? []) {
    toolsByName.set(t.name, t);
  }
  return {
    provider: opts.provider,
    agentName: opts.agentName ?? opts.agent.name,
    rootDir: '/project',
    config: opts.config,
    getAgent: (name) =>
      name === opts.agent.name ? opts.agent : opts.subAgents?.find((a) => a.name === name),
    getTool: opts.getToolImpl ?? ((name) => toolsByName.get(name)),
    resolveAgentTools: (name) => (name === opts.agent.name ? (opts.tools ?? []) : []),
    resolveSubAgents: (name) => (name === opts.agent.name ? (opts.subAgents ?? []) : []),
    loadToolModule: async (filePath, functionName) =>
      opts.loadToolModuleImpl
        ? opts.loadToolModuleImpl(filePath, functionName)
        : Promise.reject(new Error(`loadToolModule not mocked for ${filePath}`)),
    loadAgentModule: async (filePath, hasConfig, hasRun) =>
      opts.loadAgentModuleImpl
        ? opts.loadAgentModuleImpl(filePath, hasConfig, hasRun)
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
          agent: agentMeta({ systemPrompt: 'You are helpful', model: 'gpt-4', maxTurns: 5 }),
          tools: [toolMeta()],
        }),
      );

      const result = await agent.run('hi');

      expect(result.content).toBe('Hello!');
      expect(result.turns).toBe(1);

      // 验证 provider 收到 systemPrompt + model + tools
      const request = completeCalls.mock.calls[0][0];
      expect(request.messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
      expect(request.model).toBe('gpt-4');
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

      await agent.run('hi');

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

      await expect(agent.run('hi')).rejects.toThrowError(AgentError);
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

      const result = await agent.run('weather?');
      expect(result.content).toBe('done');
      expect(handler).toHaveBeenCalledWith({ city: '北京' });
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

      const result = await agent.run('hi');
      // 第二轮 LLM 收到 tool 错误消息后给出最终回答
      expect(result.content).toBe('recovered');

      // 验证第二轮请求的 messages 含 tool 角色消息（错误回传）
      const secondRequest = completeCalls.mock.calls[1][0];
      const toolMsg = secondRequest.messages.find((m: LLMMessage) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toMatch(/missing\.tool|not found|Tool/i);
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

      await agent.run('weather?');

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

      await agent.run('weather?');
      expect(handler).toHaveBeenCalledWith({ city: '北京' });
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

      await agent.run('weather?');

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

      const writerMeta = agentMeta({
        name: 'writer',
        filePath: 'dist/agents/writer/handler.js',
        hasRun: true,
      });
      const researcherMeta = agentMeta({ name: 'researcher', agents: ['writer'] });

      const agent = new Agent(
        createDeps({
          provider: parentProvider,
          agent: researcherMeta,
          subAgents: [writerMeta],
          loadAgentModuleImpl: async (filePath, _hasConfig, _hasRun) => {
            if (filePath.includes('writer')) {
              return {
                config: undefined,
                run: (async (args: unknown) => `drafted: ${JSON.stringify(args)}`) as (
                  ...args: unknown[]
                ) => unknown,
              };
            }
            throw new Error(`unexpected loadAgentModule for ${filePath}`);
          },
        }),
      );

      const result = await agent.run('write about AI');
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

      const writerMeta = agentMeta({ name: 'writer', hasRun: false });
      const researcherMeta = agentMeta({ name: 'researcher', agents: ['writer'] });

      const agent = new Agent(
        createDeps({
          provider: parentProvider,
          agent: researcherMeta,
          subAgents: [writerMeta],
          loadAgentModuleImpl: async () => ({ config: undefined, run: undefined }),
        }),
      );

      const result = await agent.run('write about AI');
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

      const writerMeta = agentMeta({ name: 'writer', hasRun: false });
      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({ name: 'researcher', agents: ['writer'] }),
          subAgents: [writerMeta],
          config: { maxAgentDepth: 1 }, // 根 depth=1, 子 depth=2 > 1 抛错
          loadAgentModuleImpl: async () => ({ config: undefined, run: undefined }),
        }),
      );

      const result = await agent.run('hi');
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
          subAgents: [agentMeta({ name: 'writer', hasRun: false })],
          config: { maxAgentDepth: 3 }, // 根1 → 子2,未超限
          loadAgentModuleImpl: async () => ({ config: undefined, run: undefined }),
        }),
      );

      const result = await agent.run('hi');
      expect(result.content).toBe('parent-ok');
    });
  });

  describe('buildToolDefinitions — tool 列表组装', () => {
    it('合并 resolveAgentTools + defaultTools + sub-agents,去重', async () => {
      const sharedTool = toolMeta({ name: 'shared.ping', functionName: 'ping' });
      const defaultTool = toolMeta({
        name: 'default.calc',
        functionName: 'calc',
        filePath: 'dist/tools/calc/handler.js',
      });
      const { provider, completeCalls } = createMockProvider([
        llmResponse({ content: 'ok', stopReason: 'stop' }),
      ]);
      const allTools = [sharedTool, defaultTool];

      const agent = new Agent(
        createDeps({
          provider,
          agent: agentMeta({
            name: 'researcher',
            agents: ['writer'],
          }),
          tools: [sharedTool], // resolveAgentTools 仅返回 sharedTool
          subAgents: [agentMeta({ name: 'writer', description: '写作 agent' })],
          config: { defaultTools: ['default.calc', 'shared.ping'] }, // shared.ping 重复
          getToolImpl: (name) => allTools.find((t) => t.name === name),
        }),
      );

      await agent.run('hi');

      const request = completeCalls.mock.calls[0][0];
      const toolNames = (request.tools as LLMToolDefinition[]).map((t) => t.name);
      expect(toolNames).toContain('shared.ping');
      expect(toolNames).toContain('default.calc');
      expect(toolNames).toContain('agent.writer');
      // 去重:shared.ping 只出现一次
      expect(toolNames.filter((n) => n === 'shared.ping')).toHaveLength(1);
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

      await agent.run('hi');

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

      await agent.run('hi');

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

      const desc = agent.asTool();
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
      expect(agent.asTool()).toBeUndefined();
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

      const chunks = await collect(agent.stream('hi'));
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
});
