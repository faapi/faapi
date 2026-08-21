import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  FaapiConfig,
  LifecycleHooks,
  LifecycleContext,
  AgentConfig,
  LlmConfig,
} from './configTypes';
import type { RouteManifest } from '../router/routeTypes';
import type { Server } from 'node:http';

describe('configTypes', () => {
  it('FaapiConfig 类型可正确构造(包含所有字段)', () => {
    const config: FaapiConfig = {
      port: 3000,
      cors: { origin: '*' },
      lifecycle: {
        onReady: async () => {},
        onClose: async () => {},
      },
    };
    expect(config.port).toBe(3000);
  });

  it('FaapiConfig 的可选字段可以省略', () => {
    const config: FaapiConfig = {
      port: 3000,
    };
    expect(config.cors).toBeUndefined();
    expect(config.lifecycle).toBeUndefined();
  });

  it('LifecycleHooks 类型可正确构造', () => {
    const hooks: LifecycleHooks = {
      onReady: async (ctx) => {
        console.log('ready', ctx.rootDir);
      },
      onClose: async (ctx) => {
        console.log('close', ctx.rootDir);
      },
    };
    expect(typeof hooks.onReady).toBe('function');
    expect(typeof hooks.onClose).toBe('function');
  });

  it('LifecycleContext 类型可正确构造', () => {
    const ctx: LifecycleContext = {
      rootDir: '/app',
      routes: [] as RouteManifest,
      server: {} as Server,
    };
    expect(ctx.rootDir).toBe('/app');
    expect(ctx.routes).toEqual([]);
  });

  it('FaapiConfig 的 lifecycle.onReady 接收 LifecycleContext 参数', () => {
    const config: FaapiConfig = {
      port: 3000,
      lifecycle: {
        onReady: (ctx: LifecycleContext) => {
          expectTypeOf(ctx).toMatchTypeOf<LifecycleContext>();
          expectTypeOf(ctx.rootDir).toBeString();
          expectTypeOf(ctx.routes).toMatchTypeOf<RouteManifest>();
          expectTypeOf(ctx.server).toMatchTypeOf<Server>();
        },
      },
    };
    expect(typeof config.lifecycle!.onReady).toBe('function');
  });

  it('FaapiConfig 支持自定义业务配置(任意 key)', () => {
    const config: FaapiConfig = {
      port: 3000,
      db: { host: 'localhost', port: 5432 },
      redis: { host: '127.0.0.1', port: 6379 },
    };
    expect((config as { db: { host: string } }).db.host).toBe('localhost');
  });

  describe('agent 配置块（Phase 2.4）', () => {
    it('FaapiConfig 支持 agent 字段', () => {
      const config: FaapiConfig = {
        agent: {
          llm: {
            provider: 'openai',
            apiKey: 'sk-xxx',
            model: 'gpt-4o',
          },
          defaultAgent: 'researcher',
          defaultTools: ['weather.getWeather'],
          maxTurns: 10,
          maxAgentDepth: 3,
        },
      };
      expect(config.agent).toBeDefined();
      expect(config.agent!.defaultAgent).toBe('researcher');
      expect(config.agent!.maxTurns).toBe(10);
      expect(config.agent!.maxAgentDepth).toBe(3);
    });

    it('agent 字段所有子字段均可省略', () => {
      const config: FaapiConfig = {
        agent: {},
      };
      expect(config.agent).toBeDefined();
      expect(config.agent!.llm).toBeUndefined();
      expect(config.agent!.defaultAgent).toBeUndefined();
      expect(config.agent!.defaultTools).toBeUndefined();
      expect(config.agent!.maxTurns).toBeUndefined();
      expect(config.agent!.maxAgentDepth).toBeUndefined();
    });

    it('agent 字段本身可省略', () => {
      const config: FaapiConfig = {
        port: 3000,
      };
      expect(config.agent).toBeUndefined();
    });

    it('AgentConfig 类型可独立构造', () => {
      const agentConfig: AgentConfig = {
        llm: { provider: 'anthropic', apiKey: 'sk-xxx' },
        defaultAgent: 'writer',
        defaultTools: ['summarize'],
        maxTurns: 5,
        maxAgentDepth: 2,
      };
      expect(agentConfig.defaultAgent).toBe('writer');
    });

    it('LlmConfig 必填 provider 字段', () => {
      const llm: LlmConfig = {
        provider: 'openai',
      };
      expect(llm.provider).toBe('openai');
      expect(llm.apiKey).toBeUndefined();
      expect(llm.model).toBeUndefined();
      expect(llm.baseURL).toBeUndefined();
    });

    it('LlmConfig 支持自定义透传字段', () => {
      const llm: LlmConfig = {
        provider: 'openai',
        apiKey: 'sk-xxx',
        model: 'gpt-4o',
        baseURL: 'https://api.openai.com/v1',
        temperature: 0.7,
        max_tokens: 4096,
      };
      expect(llm.temperature).toBe(0.7);
      expect((llm as unknown as { max_tokens: number }).max_tokens).toBe(4096);
    });

    it('agent 配置可与 cors / lifecycle 等其他字段共存', () => {
      const config: FaapiConfig = {
        cors: { origin: '*' },
        lifecycle: { onReady: async () => {} },
        agent: {
          llm: { provider: 'openai' },
          defaultAgent: 'researcher',
        },
        db: { host: 'localhost' },
      };
      expect(config.cors).toBeDefined();
      expect(config.lifecycle).toBeDefined();
      expect(config.agent!.defaultAgent).toBe('researcher');
      expect((config as { db: { host: string } }).db.host).toBe('localhost');
    });

    it('agent.defaultTools 为字符串数组', () => {
      const config: FaapiConfig = {
        agent: {
          defaultTools: ['weather.getWeather', 'web-search.search'],
        },
      };
      expect(config.agent!.defaultTools).toHaveLength(2);
      expect(config.agent!.defaultTools![0]).toBe('weather.getWeather');
    });

    it('LlmConfig 类型校验', () => {
      expectTypeOf<LlmConfig>().toHaveProperty('provider').toBeString();
      expectTypeOf<LlmConfig>().toHaveProperty('apiKey').toEqualTypeOf<string | undefined>();
      expectTypeOf<LlmConfig>().toHaveProperty('model').toEqualTypeOf<string | undefined>();
      expectTypeOf<LlmConfig>().toHaveProperty('baseURL').toEqualTypeOf<string | undefined>();
    });

    it('AgentConfig 类型校验', () => {
      expectTypeOf<AgentConfig>().toHaveProperty('llm').toEqualTypeOf<LlmConfig | undefined>();
      expectTypeOf<AgentConfig>()
        .toHaveProperty('defaultAgent')
        .toEqualTypeOf<string | undefined>();
      expectTypeOf<AgentConfig>()
        .toHaveProperty('defaultTools')
        .toEqualTypeOf<string[] | undefined>();
      expectTypeOf<AgentConfig>().toHaveProperty('maxTurns').toEqualTypeOf<number | undefined>();
      expectTypeOf<AgentConfig>()
        .toHaveProperty('maxAgentDepth')
        .toEqualTypeOf<number | undefined>();
    });

    it('FaapiConfig.agent 类型校验', () => {
      expectTypeOf<FaapiConfig>().toHaveProperty('agent').toEqualTypeOf<AgentConfig | undefined>();
    });
  });
});
