import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Server } from 'node:http';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Mock @faapi/faapi ───────────────────────────────
// 捕获 registerAgentHandleFactory 调用 + 控制注册表/加载器访问器返回值
// 避免深度路径导入（@faapi/faapi/src/...），tsc 仅依赖公开 API 类型
vi.mock('@faapi/faapi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@faapi/faapi')>();
  return {
    ...actual,
    registerAgentHandleFactory: vi.fn(),
    getAgent: vi.fn(),
    getAgentEntry: vi.fn(),
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
  getAgentEntry,
  resolveAgentTools,
  loadToolSchema,
  getToolSchemaPath,
  type AgentConfig,
  type PluginContext,
  type AgentCore,
  type AgentMetadata,
  type ToolMetadata,
} from '@faapi/faapi';

// ─── 测试数据 ───────────────────────────────────────

// getAgent 返回 AgentCore（LLM-facing 字段）;getAgentEntry 返回 AgentMetadata（含 filePath/hasRun）
const testAgentCore: AgentCore = {
  name: 'researcher',
  description: '研究 agent',
  systemPrompt: 'you are a researcher',
};

const testAgentEntry: AgentMetadata = {
  ...testAgentCore,
  filePath: 'dist/agents/researcher/handler.js',
  hasRun: false,
};

const fullAgentConfig: AgentConfig = {
  llms: {
    openai: { provider: 'openai', apiKey: 'test-key', models: { 'gpt-4o': {} } },
  },
  defaultLlm: 'openai',
  defaultAgent: 'researcher',
  maxTurns: 10,
  maxAgentDepth: 3,
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
    // 默认 getAgent 返回测试 agent 的 AgentCore（LLM-facing 字段）
    vi.mocked(getAgent).mockReturnValue(testAgentCore);
    // getAgentEntry 返回 AgentMetadata（含 filePath/hasRun,供加载 handler.js）
    vi.mocked(getAgentEntry).mockReturnValue(testAgentEntry);
  });

  describe('setup() — 完整配置', () => {
    it('调 registerAgentHandleFactory 注册工厂', () => {
      plugin.setup(makeCtx(fullAgentConfig));
      expect(registerAgentHandleFactory).toHaveBeenCalledTimes(1);
      expect(typeof registerAgentHandleFactory).toBe('function');
    });

    it('调 createProvider 传入 agent.llms 每项配置', () => {
      plugin.setup(makeCtx(fullAgentConfig));
      expect(createProvider).toHaveBeenCalledTimes(1);
      expect(createProvider).toHaveBeenCalledWith(fullAgentConfig.llms!.openai);
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

    it('config.agent.llms 未设置时不注册工厂', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      plugin.setup(makeCtx({ defaultAgent: 'researcher' }));

      expect(registerAgentHandleFactory).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('config.agent.llms not configured'),
      );
      warnSpy.mockRestore();
    });

    it('config.agent.defaultAgent 未设置时正常注册工厂（agentName 为空字符串）', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      plugin.setup(
        makeCtx({
          llms: { openai: { provider: 'openai', apiKey: 'k', models: { 'gpt-4o': {} } } },
        }),
      );

      expect(registerAgentHandleFactory).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no defaultAgent set'));
      logSpy.mockRestore();
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
      vi.mocked(resolveAgentTools).mockReturnValue([cacheTool]);
      plugin.setup(makeCtx(fullAgentConfig));
      return vi.mocked(registerAgentHandleFactory).mock.calls[0]?.[0] as
        | ((ctx: unknown) => unknown)
        | undefined;
    }

    it('两个请求（两个 Agent 实例）只解析一次 schema', async () => {
      const factory = setupWithCacheTool();
      const a1 = factory!(makeReqCtx()) as AgentHandle;
      const a2 = factory!(makeReqCtx()) as AgentHandle;

      await a1.run('hi');
      await a2.run('hi');

      // 第二个请求命中插件级缓存（zod.js mtime 未变），不重新 loadToolSchema
      expect(vi.mocked(loadToolSchema)).toHaveBeenCalledTimes(1);
    });

    it('并发请求共享同一次解析（in-flight 去重）', async () => {
      const factory = setupWithCacheTool();
      const a1 = factory!(makeReqCtx()) as AgentHandle;
      const a2 = factory!(makeReqCtx()) as AgentHandle;

      // 同一轮事件循环发起：第二个请求命中已缓存的 in-flight Promise
      await Promise.all([a1.run('hi'), a2.run('hi')]);

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
      vi.mocked(resolveAgentTools).mockReturnValue([tool]);
      const zodPath = getToolSchemaPath(tool, rootDir);
      mkdirSync(join(zodPath, '..'), { recursive: true });
      writeFileSync(zodPath, 'export const CacheInputSchema = {};');

      try {
        const ctx = makeCtx(fullAgentConfig);
        (ctx as { rootDir: string }).rootDir = rootDir;
        plugin.setup(ctx);
        const factory = vi.mocked(registerAgentHandleFactory).mock.calls[0]?.[0] as
          | ((ctx: unknown) => unknown)
          | undefined;

        const a1 = factory!(makeReqCtx()) as AgentHandle;
        await a1.run('hi');
        expect(vi.mocked(loadToolSchema)).toHaveBeenCalledTimes(1);

        // bump mtime（模拟 dev reloadTools 重生成 zod.js）
        const later = new Date(Date.now() + 10_000);
        utimesSync(zodPath, later, later);

        const a2 = factory!(makeReqCtx()) as AgentHandle;
        await a2.run('hi');
        // mtime 变化 → 缓存失效 → 重新解析
        expect(vi.mocked(loadToolSchema)).toHaveBeenCalledTimes(2);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });
});
