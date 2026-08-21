import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Server } from 'node:http';

// ─── Mock @faapi/faapi ───────────────────────────────
// 捕获 registerAgentHandleFactory 调用 + 控制注册表/加载器访问器返回值
// 避免深度路径导入（@faapi/faapi/src/...），tsc 仅依赖公开 API 类型
vi.mock('@faapi/faapi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@faapi/faapi')>();
  return {
    ...actual,
    registerAgentHandleFactory: vi.fn(),
    getAgent: vi.fn(),
    getTool: vi.fn(),
    resolveAgentTools: vi.fn(() => []),
    resolveSubAgents: vi.fn(() => []),
    loadAgentModule: vi.fn(),
    loadToolModule: vi.fn(),
    loadToolSchema: vi.fn(),
  };
});

// ─── Mock ./provider 避免 real HTTP ──────────────────
vi.mock('./provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider')>();
  const mockProvider = {
    async complete() {
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
import plugin from './plugin';
import { createProvider } from './provider';
import { Agent } from './agent';
import type { AgentHandle } from './agentHandle';
import { z } from 'zod';
import {
  registerAgentHandleFactory,
  getAgent,
  resolveAgentTools,
  loadToolSchema,
  type AgentConfig,
  type PluginContext,
  type AgentMetadata,
  type ToolMetadata,
} from '@faapi/faapi';

// ─── 测试数据 ───────────────────────────────────────

const testAgentMeta: AgentMetadata = {
  name: 'researcher',
  filePath: 'dist/agents/researcher/handler.js',
  hasConfig: true,
  hasRun: false,
  description: '研究 agent',
  systemPrompt: 'you are a researcher',
};

const fullAgentConfig: AgentConfig = {
  llm: { provider: 'openai', apiKey: 'test-key', model: 'gpt-4o' },
  defaultAgent: 'researcher',
  maxTurns: 10,
  maxAgentDepth: 3,
  defaultTools: [],
};

/** 构造 mock PluginContext */
function makeCtx(agentConfig?: AgentConfig): PluginContext {
  return {
    rootDir: '/project',
    routes: [],
    getRoutes: () => [],
    server: {} as Server,
    config: agentConfig ? { agent: agentConfig } : {},
    options: undefined,
  };
}

/** 构造 mock FaapiContext（工厂参数） */
function makeReqCtx() {
  return {} as import('@faapi/faapi').FaapiContext;
}

describe('@faapi/agent plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认 getAgent 返回测试 agent 元数据
    vi.mocked(getAgent).mockReturnValue(testAgentMeta);
  });

  describe('setup() — 完整配置', () => {
    it('调 registerAgentHandleFactory 注册工厂', () => {
      plugin.setup(makeCtx(fullAgentConfig));
      expect(registerAgentHandleFactory).toHaveBeenCalledTimes(1);
      expect(typeof registerAgentHandleFactory).toBe('function');
    });

    it('调 createProvider 传入 agent.llm 配置', () => {
      plugin.setup(makeCtx(fullAgentConfig));
      expect(createProvider).toHaveBeenCalledTimes(1);
      expect(createProvider).toHaveBeenCalledWith(fullAgentConfig.llm);
    });

    it('工厂返回 Agent 实例（满足 AgentHandle）', () => {
      plugin.setup(makeCtx(fullAgentConfig));

      const factory = vi.mocked(registerAgentHandleFactory).mock.calls[0]?.[0] as
        | ((ctx: unknown) => unknown)
        | undefined;
      expect(factory).toBeDefined();

      const handle = factory!(makeReqCtx()) as AgentHandle;
      expect(handle).toBeInstanceOf(Agent);
      expect(typeof handle.run).toBe('function');
      expect(typeof handle.stream).toBe('function');
      expect(typeof handle.asTool).toBe('function');
    });

    it('工厂返回的 Agent 绑定 defaultAgent 名', () => {
      plugin.setup(makeCtx(fullAgentConfig));

      const factory = vi.mocked(registerAgentHandleFactory).mock.calls[0]?.[0] as
        | ((ctx: unknown) => unknown)
        | undefined;
      const agent = factory!(makeReqCtx()) as Agent;

      const tool = agent.asTool();
      expect(tool).toBeDefined();
      expect(tool?.agentName).toBe('researcher');
      expect(tool?.name).toBe('agent.researcher');
    });

    it('每次调工厂构造新 Agent 实例', () => {
      plugin.setup(makeCtx(fullAgentConfig));

      const factory = vi.mocked(registerAgentHandleFactory).mock.calls[0]?.[0] as
        | ((ctx: unknown) => unknown)
        | undefined;
      const h1 = factory!(makeReqCtx());
      const h2 = factory!(makeReqCtx());
      expect(h1).not.toBe(h2);
    });
  });

  describe('setup() — 配置缺失', () => {
    it('config.agent 整块未设置时不注册工厂', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      plugin.setup(makeCtx(undefined));

      expect(registerAgentHandleFactory).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('config.agent.llm 未设置时不注册工厂', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      plugin.setup(makeCtx({ defaultAgent: 'researcher' }));

      expect(registerAgentHandleFactory).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('config.agent.llm not configured'),
      );
      warnSpy.mockRestore();
    });

    it('config.agent.defaultAgent 未设置时不注册工厂', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      plugin.setup(makeCtx({ llm: { provider: 'openai', apiKey: 'k', model: 'gpt-4o' } }));

      expect(registerAgentHandleFactory).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('config.agent.defaultAgent not configured'),
      );
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
      plugin.setup(makeCtx(fullAgentConfig));

      const factory = vi.mocked(registerAgentHandleFactory).mock.calls[0]?.[0] as
        | ((ctx: unknown) => unknown)
        | undefined;
      const agent = factory!(makeReqCtx()) as AgentHandle;
      const result = await agent.run('hello');
      expect(result.content).toBe('ok');
      expect(result.turns).toBe(1);
      expect(result.stopReason).toBe('stop');
    });

    it('agent.stream yield 流式 chunk', async () => {
      plugin.setup(makeCtx(fullAgentConfig));

      const factory = vi.mocked(registerAgentHandleFactory).mock.calls[0]?.[0] as
        | ((ctx: unknown) => unknown)
        | undefined;
      const agent = factory!(makeReqCtx()) as AgentHandle;
      const chunks: { deltaContent?: string; done?: { content: string } }[] = [];
      for await (const chunk of agent.stream('hello')) {
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

    it('buildToolDefinitions 调 loadToolSchema 加载 tool schema', async () => {
      const mockSchema = z.object({ city: z.string() });
      vi.mocked(loadToolSchema).mockResolvedValue({
        schema: mockSchema,
        schemaName: 'TestInputSchema',
      });
      vi.mocked(resolveAgentTools).mockReturnValue([testTool]);

      plugin.setup(makeCtx(fullAgentConfig));
      const factory = vi.mocked(registerAgentHandleFactory).mock.calls[0]?.[0] as
        | ((ctx: unknown) => unknown)
        | undefined;
      const agent = factory!(makeReqCtx()) as AgentHandle;
      await agent.run('hello');

      expect(loadToolSchema).toHaveBeenCalledWith(testTool, '/project');
    });

    it('loadToolSchema 返回 undefined 时不报错（用自由 schema）', async () => {
      vi.mocked(loadToolSchema).mockResolvedValue(undefined);
      vi.mocked(resolveAgentTools).mockReturnValue([testTool]);

      plugin.setup(makeCtx(fullAgentConfig));
      const factory = vi.mocked(registerAgentHandleFactory).mock.calls[0]?.[0] as
        | ((ctx: unknown) => unknown)
        | undefined;
      const agent = factory!(makeReqCtx()) as AgentHandle;
      const result = await agent.run('hello');

      expect(result.content).toBe('ok');
      expect(loadToolSchema).toHaveBeenCalledWith(testTool, '/project');
    });
  });
});
