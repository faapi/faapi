import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Server } from 'node:http';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Mock @faapi/faapi ───────────────────────────────
// 只 mock 无状态加载器（loadToolModule / loadToolSchema）。
// 注册表不再走全局单例——插件读写 ctx.registries（app 实例，测试用
// createAppRegistries() 构造真实实例并直接种数据）
vi.mock('@faapi/faapi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@faapi/faapi')>();
  return {
    ...actual,
    loadToolModule: vi.fn(),
  };
});

// createToolSchemaResolver 已下沉主包 loader 域，其内部经深路径 import
// loadToolSchema——mock 需指向该模块本体（getToolSchemaPath 是纯路径计算，保持真实）
vi.mock('@faapi/faapi/src/loaders/loadToolSchema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@faapi/faapi/src/loaders/loadToolSchema')>();
  return {
    ...actual,
    loadToolSchema: vi.fn(),
  };
});

// ─── Mock ./provider 避免 real HTTP ──────────────────
// completeRequests 经 vi.hoisted 跨 mock 边界共享——配置映射用例断言 Agent 实际发给
// provider 的 system 消息（traceId 开关/模板经 plugin → AgentRuntimeConfig 生效）
const { completeRequests } = vi.hoisted(() => ({
  completeRequests: [] as { messages: unknown[] }[],
}));

vi.mock('./provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider')>();
  const mockProvider = {
    async complete(request: { messages: unknown[] }) {
      completeRequests.push(request);
      return {
        message: { role: 'assistant' as const, content: 'ok' },
        stopReason: 'stop' as const,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async *stream() {
      yield { deltaContent: 'ok' };
      yield { finishReason: 'stop' as const };
    },
  };
  return {
    ...actual,
    createProvider: vi.fn(() => mockProvider),
  };
});

// ─── 导入（mock 后）─────────────────────────────────
import { createAppRegistries } from '@faapi/faapi';
import plugin from './plugin';
import type { AgentDeps } from './agent';
import { createProvider, type LLMProvider } from './provider';
import { Agent, AgentError } from './agent';
import { createStandaloneToolContext } from './standaloneToolContext';
import type { AgentHandle } from './agentHandle';
import { z } from 'zod';
import { loadToolSchema, getToolSchemaPath } from '@faapi/faapi/src/loaders/loadToolSchema';
import {
  type AgentConfig,
  type PluginContext,
  type AgentCore,
  type AgentMetadata,
  type ToolMetadata,
} from '@faapi/faapi';

// ─── 测试数据 ───────────────────────────────────────

// getAgent 返回 AgentCore（LLM-facing 字段）;getAgentEntry 返回 AgentMetadata（含 filePath）
const testAgentCore: AgentCore = {
  name: 'researcher',
  description: '研究 agent',
  systemPrompt: 'you are a researcher',
};

const testAgentEntry: AgentMetadata = {
  ...testAgentCore,
  filePath: 'dist/agents/researcher/handler.js',
};

const fullAgentConfig: AgentConfig = {
  llms: {
    openai: { provider: 'openai', apiKey: 'test-key', models: { 'gpt-4o': {} } },
  },
  maxTurns: 10,
  maxAgentDepth: 3,
};

/** 构造 mock PluginContext（真实 app 级注册表实例，预置测试 agent） */
function makeCtx(agentConfig?: AgentConfig): PluginContext {
  const ctx: PluginContext = {
    rootDir: '/project',
    registries: createAppRegistries(),
    routes: [],
    getRoutes: () => [],
    server: {} as Server,
    config: agentConfig ? { agent: agentConfig } : {},
    options: undefined,
  };
  ctx.registries.agent.hydrate([testAgentEntry]);
  return ctx;
}

/**
 * setup 插件并捕获注册到 agentHandle store 的工厂函数
 *
 * 方案 A：插件经 ctx.registries.agentHandle.register 注册到 app 实例，
 * 测试用 spy 捕获（替代旧全局 registerAgentHandleFactory mock）
 */
function setupAndCaptureFactory(ctx: PluginContext): ((reqCtx: unknown) => unknown) | undefined {
  const spy = vi.spyOn(ctx.registries.agentHandle, 'register');
  plugin.setup(ctx);
  return spy.mock.calls[0]?.[0] as ((reqCtx: unknown) => unknown) | undefined;
}

/** 构造 mock FaapiContext（工厂参数） */
function makeReqCtx() {
  return {} as import('@faapi/faapi').FaapiContext;
}

describe('@faapi/agent plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('setup() — llm 轻量补全通道注册', () => {
    it('llms 已配置：channel 注册到 registries.llm，complete 走 providers 同源实例', async () => {
      const ctx = makeCtx(fullAgentConfig);
      plugin.setup(ctx);
      const channel = ctx.registries.llm.get();
      expect(channel).toBeDefined();
      expect(typeof channel!.complete).toBe('function');
      // 与 agent 循环同一 providers 实例（mock createProvider 的返回）
      await expect(channel!.complete('x', { model: 'openai' })).resolves.toBe('ok');
    });

    it('llms 未配置：channel 仍注册，调用时报 AgentError（无 provider 可解析）', async () => {
      const ctx = makeCtx();
      plugin.setup(ctx);
      const channel = ctx.registries.llm.get();
      expect(channel).toBeDefined();
      await expect(channel!.complete('x')).rejects.toThrow(AgentError);
    });
  });

  describe('setup() — 完整配置', () => {
    it('调 ctx.registries.agentHandle.register 注册工厂（app 实例，非全局）', () => {
      const ctx = makeCtx(fullAgentConfig);
      const spy = vi.spyOn(ctx.registries.agentHandle, 'register');
      plugin.setup(ctx);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(typeof spy.mock.calls[0]?.[0]).toBe('function');
    });

    it('调 createProvider 传入 agent.llms 每项配置', () => {
      plugin.setup(makeCtx(fullAgentConfig));
      expect(createProvider).toHaveBeenCalledTimes(1);
      expect(createProvider).toHaveBeenCalledWith(fullAgentConfig.llms!.openai);
    });

    it('工厂返回 Agent 实例（满足 AgentHandle）', () => {
      const factory = setupAndCaptureFactory(makeCtx(fullAgentConfig));
      expect(factory).toBeDefined();

      const handle = factory!(makeReqCtx()) as AgentHandle;
      expect(handle).toBeInstanceOf(Agent);
      expect(typeof handle.run).toBe('function');
      expect(typeof handle.stream).toBe('function');
      expect(typeof handle.asTool).toBe('function');
    });

    it('工厂返回的 Agent 支持显式指定 agent 名（asTool）', () => {
      const factory = setupAndCaptureFactory(makeCtx(fullAgentConfig));
      const agent = factory!(makeReqCtx()) as Agent;

      // 无默认 agent——asTool 需显式传名
      const tool = agent.asTool('researcher');
      expect(tool).toBeDefined();
      expect(tool?.agentName).toBe('researcher');
      expect(tool?.name).toBe('agent-researcher');
    });

    it('run 不传 options.agent 时抛 AgentError（无默认 agent）', async () => {
      const factory = setupAndCaptureFactory(makeCtx(fullAgentConfig));
      const agent = factory!(makeReqCtx()) as Agent;

      await expect(agent.run('hello')).rejects.toThrowError(AgentError);
    });

    it('每次调工厂构造新 Agent 实例', () => {
      const factory = setupAndCaptureFactory(makeCtx(fullAgentConfig));
      const h1 = factory!(makeReqCtx());
      const h2 = factory!(makeReqCtx());
      expect(h1).not.toBe(h2);
    });

    it('config.agent.traceId:false 映射 AgentRuntimeConfig——run 的 system 消息无 trace 注入块', async () => {
      completeRequests.length = 0;
      const factory = setupAndCaptureFactory(makeCtx({ ...fullAgentConfig, traceId: false }));
      const agent = factory!(makeReqCtx()) as Agent;

      const result = await agent.run('hello', { agent: 'researcher', model: 'gpt-4o' });
      expect(result.content).toBe('ok');
      expect(result.traceId).toBeUndefined();
      expect(completeRequests[0]!.messages[0]).toEqual({
        role: 'system',
        content: 'you are a researcher',
      });
    });

    it('config.agent.traceIdTemplate 映射 AgentRuntimeConfig——run 的 system 消息用自定义文案', async () => {
      completeRequests.length = 0;
      const factory = setupAndCaptureFactory(
        makeCtx({ ...fullAgentConfig, traceIdTemplate: 'T={traceId}' }),
      );
      const agent = factory!(makeReqCtx()) as Agent;

      const result = await agent.run('hello', { agent: 'researcher', model: 'gpt-4o' });
      expect(result.traceId).toMatch(/^[0-9a-f]{12}$/);
      expect(completeRequests[0]!.messages[0]).toEqual({
        role: 'system',
        content: `you are a researcher\n\nT=${result.traceId}`,
      });
    });

    it('config.agent.enableTracing:true 经复合块到达运行时——run 返回 result.trace', async () => {
      // 历史缺口复现：插件手写清单曾漏拼 enableTracing（配置静默失效回落 false）
      completeRequests.length = 0;
      const factory = setupAndCaptureFactory(makeCtx({ ...fullAgentConfig, enableTracing: true }));
      const agent = factory!(makeReqCtx()) as Agent;

      const result = await agent.run('hello', { agent: 'researcher', model: 'gpt-4o' });
      expect(result.content).toBe('ok');
      expect(result.trace).toBeDefined();
      expect(result.trace!.traceId).toBe(result.traceId);
    });

    it('config.agent.decorateDeps 经插件工厂产物生效——配方装饰的 resolveSystemPrompt 进 system 消息', async () => {
      // 进程级 deps 配方走 config.agent 声明：插件 setup 装配 baseDeps 时应用,
      // 工厂产物（HTTP 请求链注入的 AgentHandle）自动携带配方
      completeRequests.length = 0;
      const decorate = (deps: import('./agent').AgentDeps) => ({
        ...deps,
        resolveSystemPrompt: async (_name: string, _meta: unknown, base: string) =>
          `${base}\n[配方注入]`,
      });
      const factory = setupAndCaptureFactory(
        makeCtx({ ...fullAgentConfig, decorateDeps: decorate }),
      );
      const agent = factory!(makeReqCtx()) as Agent;

      const result = await agent.run('hello', { agent: 'researcher', model: 'gpt-4o' });
      expect(result.content).toBe('ok');
      expect(completeRequests[0]!.messages[0]).toEqual({
        role: 'system',
        content: expect.stringContaining('[配方注入]'),
      });
    });
  });

  describe('setup() — 配置缺失', () => {
    it('config.agent 整块未设置时仍注册工厂（外部 provider 模式）', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const ctx = makeCtx(undefined);
      const factory = setupAndCaptureFactory(ctx);

      expect(factory).toBeDefined();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no llms configured'));
      logSpy.mockRestore();
    });

    it('config.agent.llms 未设置时仍注册工厂,createProvider 不被调用', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const ctx = makeCtx({});
      const factory = setupAndCaptureFactory(ctx);

      expect(factory).toBeDefined();
      expect(createProvider).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no llms configured'));
      logSpy.mockRestore();
    });

    it('llms 未配置时:run 不传 options.provider 抛 AgentError,传外部 provider 正常执行', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const ctx = makeCtx({});
      const factory = setupAndCaptureFactory(ctx);
      logSpy.mockRestore();
      const agent = factory!(makeReqCtx()) as Agent;

      // 不传 options.provider:无 provider 可解析,早失败（AgentError,不发起 LLM 请求）
      await expect(agent.run('hi', { agent: 'researcher' })).rejects.toThrowError(AgentError);

      // 传 options.provider:外部 provider 接管,正常执行（BYOK 纯外部模式）
      const external: LLMProvider = {
        complete: async () => ({
          message: { role: 'assistant' as const, content: 'from-external' },
          stopReason: 'stop' as const,
        }),
        stream: async function* () {
          yield { deltaContent: 'x', finishReason: 'stop' as const };
        },
      };
      const result = await agent.run('hi', { agent: 'researcher', provider: external });
      expect(result.content).toBe('from-external');
    });

    it('config.agent 只含 maxTurns 时正常注册工厂', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const ctx = makeCtx({ maxTurns: 5 });
      const spy = vi.spyOn(ctx.registries.agentHandle, 'register');
      plugin.setup(ctx);

      expect(spy).toHaveBeenCalledTimes(1);
      logSpy.mockRestore();
    });
  });

  describe('setup() — llms.apiKey 校验', () => {
    it('apiKey 为空字符串时 warn 提示对应 provider,工厂照常注册', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = makeCtx({
        llms: { openai: { provider: 'openai', apiKey: '', models: { 'gpt-4o': {} } } },
      });
      const factory = setupAndCaptureFactory(ctx);

      expect(factory).toBeDefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('llms.openai.apiKey'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Authorization'));
      warnSpy.mockRestore();
    });

    it('apiKey 未设置（undefined）时同样 warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = makeCtx({
        llms: { openai: { provider: 'openai', models: { 'gpt-4o': {} } } },
      });
      const factory = setupAndCaptureFactory(ctx);

      expect(factory).toBeDefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('llms.openai.apiKey'));
      warnSpy.mockRestore();
    });

    it('apiKey 为纯空白字符时视为空,warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = makeCtx({
        llms: { openai: { provider: 'openai', apiKey: '   ', models: { 'gpt-4o': {} } } },
      });
      const factory = setupAndCaptureFactory(ctx);

      expect(factory).toBeDefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('llms.openai.apiKey'));
      warnSpy.mockRestore();
    });

    it('多 provider 混合时只 warn 空 key 的那个,所有 provider 均注册', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = makeCtx({
        llms: {
          openai: { provider: 'openai', apiKey: '', models: { 'gpt-4o': {} } },
          gateway: { provider: 'openai', apiKey: 'real-key', models: { 'gpt-4o': {} } },
        },
      });
      const factory = setupAndCaptureFactory(ctx);

      expect(factory).toBeDefined();
      expect(createProvider).toHaveBeenCalledTimes(2);
      const warnMessages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(warnMessages.some((msg) => msg.includes('llms.openai.apiKey'))).toBe(true);
      expect(warnMessages.some((msg) => msg.includes('llms.gateway.apiKey'))).toBe(false);
      warnSpy.mockRestore();
    });

    it('apiKey 已配置时无 apiKey 相关 warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      plugin.setup(makeCtx(fullAgentConfig));

      const warnMessages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(warnMessages.some((msg) => msg.includes('apiKey'))).toBe(false);
      warnSpy.mockRestore();
    });
  });

  describe('插件元信息', () => {
    it('name 为 @faapi/agent', () => {
      expect(plugin.name).toBe('@faapi/agent');
    });

    it('setup 为函数', () => {
      expect(typeof plugin.setup).toBe('function');
    });
  });

  describe('工厂输出 — run / stream', () => {
    it('agent.run 返回 ReactLoopResult', async () => {
      const factory = setupAndCaptureFactory(makeCtx(fullAgentConfig));
      const agent = factory!(makeReqCtx()) as AgentHandle;
      const result = await agent.run('hello', { agent: 'researcher', model: 'gpt-4o' });
      expect(result.content).toBe('ok');
      expect(result.turns).toBe(1);
      expect(result.stopReason).toBe('stop');
    });

    it('agent.stream yield 流式 chunk', async () => {
      const factory = setupAndCaptureFactory(makeCtx(fullAgentConfig));
      const agent = factory!(makeReqCtx()) as AgentHandle;
      const chunks: { deltaContent?: string; done?: { content: string } }[] = [];
      for await (const chunk of agent.stream('hello', { agent: 'researcher', model: 'gpt-4o' })) {
        chunks.push(chunk);
      }
      const done = chunks.find((c) => c.done !== undefined);
      expect(done?.done?.content).toBe('ok');
    });
  });

  describe('resolveToolSchema 集成', () => {
    /** 构造带 inputTypeName 的 tool 元数据 */
    const testTool: ToolMetadata = {
      name: 'test.tool',
      functionName: 'testFn',
      inputTypeName: 'TestInput',
      filePath: 'dist/tools/test/handler.js',
    };

    /** makeCtx + 种入声明了 test.tool 的 agent 与 tool 注册表 */
    function makeCtxWithTool(agentConfig?: AgentConfig): PluginContext {
      const ctx = makeCtx(agentConfig);
      // agent 声明使用 test.tool（resolveAgentTools 按声明过滤 tool 注册表）
      ctx.registries.agent.hydrate([{ ...testAgentEntry, tools: ['test.tool'] } as AgentMetadata]);
      ctx.registries.tool.hydrate([testTool]);
      return ctx;
    }

    it('buildToolDefinitions 调 loadToolSchema 加载 tool schema', async () => {
      const mockSchema = z.object({ city: z.string() });
      vi.mocked(loadToolSchema).mockResolvedValue({
        schema: mockSchema,
        schemaName: 'TestInputSchema',
      });

      const factory = setupAndCaptureFactory(makeCtxWithTool(fullAgentConfig));
      const agent = factory!(makeReqCtx()) as AgentHandle;
      await agent.run('hello', { agent: 'researcher', model: 'gpt-4o' });

      expect(loadToolSchema).toHaveBeenCalledWith(testTool, '/project', undefined);
    });

    it('loadToolSchema 返回 undefined 时不报错（用自由 schema）', async () => {
      vi.mocked(loadToolSchema).mockResolvedValue(undefined);

      const factory = setupAndCaptureFactory(makeCtxWithTool(fullAgentConfig));
      const agent = factory!(makeReqCtx()) as AgentHandle;
      const result = await agent.run('hello', { agent: 'researcher', model: 'gpt-4o' });

      expect(result.content).toBe('ok');
      expect(loadToolSchema).toHaveBeenCalledWith(testTool, '/project', undefined);
    });
  });

  describe('resolveToolSchema 跨请求缓存', () => {
    const cacheTool: ToolMetadata = {
      name: 'cache.tool',
      functionName: 'cacheFn',
      inputTypeName: 'CacheInput',
      filePath: 'dist/tools/cache/handler.js',
    };

    /** setup 并注册 tool + mock schema，返回工厂函数 */
    function setupWithCacheTool(): ((ctx: unknown) => unknown) | undefined {
      vi.mocked(loadToolSchema).mockResolvedValue({
        schema: z.object({ city: z.string() }),
        schemaName: 'CacheInputSchema',
      });
      const ctx = makeCtx(fullAgentConfig);
      ctx.registries.agent.hydrate([{ ...testAgentEntry, tools: ['cache.tool'] } as AgentMetadata]);
      ctx.registries.tool.hydrate([cacheTool]);
      return setupAndCaptureFactory(ctx);
    }

    it('两个请求（两个 Agent 实例）只解析一次 schema', async () => {
      const factory = setupWithCacheTool();
      const a1 = factory!(makeReqCtx()) as AgentHandle;
      const a2 = factory!(makeReqCtx()) as AgentHandle;

      await a1.run('hi', { agent: 'researcher', model: 'gpt-4o' });
      await a2.run('hi', { agent: 'researcher', model: 'gpt-4o' });

      // 第二个请求命中插件级缓存（zod.js mtime 未变），不重新 loadToolSchema
      expect(vi.mocked(loadToolSchema)).toHaveBeenCalledTimes(1);
    });

    it('并发请求共享同一次解析（in-flight 去重）', async () => {
      const factory = setupWithCacheTool();
      const a1 = factory!(makeReqCtx()) as AgentHandle;
      const a2 = factory!(makeReqCtx()) as AgentHandle;

      // 同一轮事件循环发起：第二个请求命中已缓存的 in-flight Promise
      await Promise.all([
        a1.run('hi', { agent: 'researcher', model: 'gpt-4o' }),
        a2.run('hi', { agent: 'researcher', model: 'gpt-4o' }),
      ]);

      expect(vi.mocked(loadToolSchema)).toHaveBeenCalledTimes(1);
    });

    it('zod.js mtime 变化后重新解析（dev reloadTools 自愈）', async () => {
      // 真实 tmp 文件：缓存用 statSync 校验 mtime，mock 的 loadToolSchema 不读文件
      const rootDir = join(
        tmpdir(),
        `faapi-agent-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const tool = { ...cacheTool, filePath: 'src/tools/cache/handler.js' };
      vi.mocked(loadToolSchema).mockResolvedValue({
        schema: z.object({ city: z.string() }),
        schemaName: 'CacheInputSchema',
      });
      const zodPath = getToolSchemaPath(tool, rootDir);
      mkdirSync(join(zodPath, '..'), { recursive: true });
      writeFileSync(zodPath, 'export const CacheInputSchema = {};');

      try {
        const ctx = makeCtx(fullAgentConfig);
        ctx.rootDir = rootDir;
        ctx.registries.agent.hydrate([
          { ...testAgentEntry, tools: ['cache.tool'] } as AgentMetadata,
        ]);
        ctx.registries.tool.hydrate([tool]);
        const factory = setupAndCaptureFactory(ctx);

        const a1 = factory!(makeReqCtx()) as AgentHandle;
        await a1.run('hi', { agent: 'researcher', model: 'gpt-4o' });
        expect(vi.mocked(loadToolSchema)).toHaveBeenCalledTimes(1);

        // bump mtime（模拟 dev reloadTools 重生成 zod.js）
        const later = new Date(Date.now() + 10_000);
        utimesSync(zodPath, later, later);

        const a2 = factory!(makeReqCtx()) as AgentHandle;
        await a2.run('hi', { agent: 'researcher', model: 'gpt-4o' });
        // mtime 变化 → 缓存失效 → 重新解析
        expect(vi.mocked(loadToolSchema)).toHaveBeenCalledTimes(2);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });
});

describe('@faapi/agent plugin — 隔离 agent 通道（agentRunner 注册）', () => {
  it('setup 注册 runner：runAgent string 入参在宿主跑完整循环（按名解析人设，ctx 为调用方传入的契约 ctx）', async () => {
    const ctx = makeCtx(fullAgentConfig);
    plugin.setup(ctx);
    const runner = ctx.registries.agentRunner.get();
    expect(runner).toBeDefined();

    const before = completeRequests.length;
    const toolCtx = createStandaloneToolContext({ currentUserId: 7 });
    const result = (await runner!.runAgent(toolCtx, {
      agentName: 'researcher',
      input: '研究量子',
      options: { model: 'gpt-4o' },
    })) as { content: string };
    // 循环在宿主跑：mock provider 收到请求，最终 assistant 内容回传
    expect(result.content).toBe('ok');
    expect(completeRequests.length).toBeGreaterThan(before);
    const first = completeRequests[before]!.messages as Array<{ role: string; content: string }>;
    // system 人设来自注册表元数据（宿主按 agentName 解析；trace 注入块不参与断言）
    expect(first[0]).toMatchObject({ role: 'system' });
    expect(first[0]!.content).toContain('you are a researcher');
  });

  it('runAgent 第三参 execution.signal：合入 run options 的 signal（宿主任务取消传播 agent 循环，宿主侧优先）', async () => {
    const ctx = makeCtx(fullAgentConfig);
    plugin.setup(ctx);
    const runner = ctx.registries.agentRunner.get()!;

    const toolCtx = createStandaloneToolContext();
    const controller = new AbortController();
    const before = completeRequests.length;
    await runner.runAgent(
      toolCtx,
      { agentName: 'researcher', input: '研究量子', options: { model: 'gpt-4o' } },
      { signal: controller.signal },
    );
    // 取消控制器随请求到达 provider（每轮 LLM 预检查 + 请求中断依赖此 signal）
    const request = completeRequests[before] as unknown as { signal?: AbortSignal };
    expect(request.signal).toBe(controller.signal);

    // options.signal 直传（无 execution.signal 时保持既有语义）
    const before2 = completeRequests.length;
    const callerController = new AbortController();
    await runner.runAgent(toolCtx, {
      agentName: 'researcher',
      input: '研究宇宙',
      options: { model: 'gpt-4o', signal: callerController.signal },
    });
    const request2 = completeRequests[before2] as unknown as { signal?: AbortSignal };
    expect(request2.signal).toBe(callerController.signal);
  });

  it('runAgent 对象入参：富派发形态经 extractSubAgentUserInput 构造 user 消息（未声明 Input 不校验）', async () => {
    const ctx = makeCtx(fullAgentConfig);
    plugin.setup(ctx);
    const runner = ctx.registries.agentRunner.get()!;

    const before = completeRequests.length;
    const toolCtx = createStandaloneToolContext();
    await runner.runAgent(toolCtx, {
      agentName: 'researcher',
      input: { q: '量子', depth: 2 },
      options: { model: 'gpt-4o' },
    });
    const messages = completeRequests[before]!.messages as Array<{
      role: string;
      content: string;
    }>;
    const lastUser = messages.filter((m) => m.role === 'user').at(-1)!;
    // 多字段对象 → JSON.stringify（extractSubAgentUserInput 语义）
    expect(lastUser.content).toBe(JSON.stringify({ q: '量子', depth: 2 }));

    const before2 = completeRequests.length;
    await runner.runAgent(toolCtx, {
      agentName: 'researcher',
      input: { input: '研究宇宙' },
      options: { model: 'gpt-4o' },
    });
    const messages2 = completeRequests[before2]!.messages as Array<{
      role: string;
      content: string;
    }>;
    const lastUser2 = messages2.filter((m) => m.role === 'user').at(-1)!;
    // 单 input 字符串字段 → 直传
    expect(lastUser2.content).toBe('研究宇宙');
  });

  it('runAgent 对象入参 + Input 声明：校验失败抛 AgentError（RPC ok:false 原样回传 worker 以任务错误浮出）', async () => {
    const ctx = makeCtx({
      ...fullAgentConfig,
      decorateDeps: (deps: unknown) => ({
        ...(deps as Record<string, unknown>),
        resolveAgentInputSchema: async () => ({
          jsonSchema: { type: 'object' },
          validate: () => ({ ok: false as const, error: 'q: Required' }),
        }),
      }),
    } as AgentConfig);
    ctx.registries.agent.hydrate([{ ...testAgentEntry, inputTypeName: 'Input' }]);
    plugin.setup(ctx);
    const runner = ctx.registries.agentRunner.get()!;

    const toolCtx = createStandaloneToolContext();
    const before = completeRequests.length;
    await expect(
      runner.runAgent(toolCtx, { agentName: 'researcher', input: { depth: 2 } }),
    ).rejects.toThrow(AgentError);
    await expect(
      runner.runAgent(toolCtx, { agentName: 'researcher', input: { depth: 2 } }),
    ).rejects.toThrow(/input validation failed/);
    // 校验失败在宿主 runAgent 内短路——循环未起，零 LLM 调用
    expect(completeRequests).toHaveLength(before);
  });

  it('runAgent 对象入参 + Input 声明：产物缺失（resolver 返回 undefined）抛 AgentError 指引重建', async () => {
    const ctx = makeCtx({
      ...fullAgentConfig,
      decorateDeps: (deps: unknown) => ({
        ...(deps as Record<string, unknown>),
        resolveAgentInputSchema: async () => undefined,
      }),
    } as AgentConfig);
    ctx.registries.agent.hydrate([{ ...testAgentEntry, inputTypeName: 'Input' }]);
    plugin.setup(ctx);
    const runner = ctx.registries.agentRunner.get()!;

    const toolCtx = createStandaloneToolContext();
    await expect(
      runner.runAgent(toolCtx, { agentName: 'researcher', input: { q: 1 } }),
    ).rejects.toThrow(/missing or broken/);
  });

  it('runAgent 字符串入参不走派发校验（user 消息直传，与 HTTP/编程式 run 同语义）', async () => {
    const ctx = makeCtx({
      ...fullAgentConfig,
      decorateDeps: (deps: unknown) => ({
        ...(deps as Record<string, unknown>),
        resolveAgentInputSchema: async () => ({
          jsonSchema: { type: 'object' },
          validate: () => ({ ok: false as const, error: 'q: Required' }),
        }),
      }),
    } as AgentConfig);
    ctx.registries.agent.hydrate([{ ...testAgentEntry, inputTypeName: 'Input' }]);
    plugin.setup(ctx);
    const runner = ctx.registries.agentRunner.get()!;

    const before = completeRequests.length;
    const toolCtx = createStandaloneToolContext();
    await expect(
      runner.runAgent(toolCtx, {
        agentName: 'researcher',
        input: '研究量子',
        options: { model: 'gpt-4o' },
      }),
    ).resolves.toMatchObject({ content: 'ok' });
    // 字符串直传绕过富 schema 校验——循环照常起（零校验报错）
    expect(completeRequests.length).toBeGreaterThan(before);
  });

  it('runAgent 契约 ctx 透传：resolveReminders 钩子收到调用方传入的 ctx（增强字段可读）', async () => {
    const captured: Array<{ turn: number; currentUserId?: number }> = [];
    const ctx = makeCtx({
      ...fullAgentConfig,
      // decorateDeps 是 config 声明钩子的生产装配路径（createAgentDeps 应用）——
      // 按真实签名标注（config 声明为 (...args: never[]) => unknown 宽松形态）
      decorateDeps: (deps: AgentDeps): AgentDeps => ({
        ...deps,
        resolveReminders: async (info) => {
          captured.push({
            turn: info.turn,
            currentUserId: (info.ctx as { currentUserId?: number }).currentUserId,
          });
          return ['r'];
        },
      }),
    });
    plugin.setup(ctx);
    const runner = ctx.registries.agentRunner.get()!;

    const toolCtx = createStandaloneToolContext({ currentUserId: 7 });
    await runner.runAgent(toolCtx, {
      agentName: 'researcher',
      input: '研究量子',
      options: { model: 'gpt-4o' },
    });
    // once（turn=0）与 everyTurn（turn=1）两通道都触发，ctx 均为调用方传入实例
    expect(captured).toEqual([
      { turn: 0, currentUserId: 7 },
      { turn: 1, currentUserId: 7 },
    ]);
  });

  it('runAgent 未知 agent 名：循环侧 AgentError 原样抛出', async () => {
    const ctx = makeCtx(fullAgentConfig);
    plugin.setup(ctx);
    const runner = ctx.registries.agentRunner.get()!;
    const toolCtx = createStandaloneToolContext();
    await expect(runner.runAgent(toolCtx, { agentName: 'nope', input: 'hi' })).rejects.toThrow(
      AgentError,
    );
  });
});
