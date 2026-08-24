import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  FaapiConfig,
  LifecycleHooks,
  LifecycleContext,
  AgentConfig,
  LlmConfig,
  LlmModelConfig,
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

  describe('agent 配置块（Phase 2.4，Phase 3.5 改为嵌套级联）', () => {
    it('FaapiConfig 支持 agent 字段（嵌套 llms + defaultLlm）', () => {
      const config: FaapiConfig = {
        agent: {
          llms: {
            openai: {
              provider: 'openai',
              apiKey: 'sk-xxx',
              models: { 'gpt-4o': {}, 'gpt-4o-mini': { temperature: 0.5 } },
            },
          },
          defaultLlm: 'openai',
          defaultAgent: 'researcher',
          maxTurns: 10,
          maxAgentDepth: 3,
        },
      };
      expect(config.agent).toBeDefined();
      expect(config.agent!.defaultAgent).toBe('researcher');
      expect(config.agent!.maxTurns).toBe(10);
      expect(config.agent!.maxAgentDepth).toBe(3);
      expect(config.agent!.llms!.openai.provider).toBe('openai');
      expect(config.agent!.llms!.openai.models!['gpt-4o']).toEqual({});
      expect(config.agent!.defaultLlm).toBe('openai');
    });

    it('agent 字段所有子字段均可省略', () => {
      const config: FaapiConfig = {
        agent: {},
      };
      expect(config.agent).toBeDefined();
      expect(config.agent!.llms).toBeUndefined();
      expect(config.agent!.defaultLlm).toBeUndefined();
      expect(config.agent!.defaultAgent).toBeUndefined();
      expect(config.agent!.maxTurns).toBeUndefined();
      expect(config.agent!.maxAgentDepth).toBeUndefined();
    });

    it('agent 字段本身可省略', () => {
      const config: FaapiConfig = {
        port: 3000,
      };
      expect(config.agent).toBeUndefined();
    });

    it('AgentConfig 类型可独立构造（多 provider 嵌套）', () => {
      const agentConfig: AgentConfig = {
        llms: {
          openai: {
            provider: 'openai',
            apiKey: 'sk-xxx',
            models: { 'gpt-4o': {} },
          },
          anthropic: {
            provider: 'anthropic',
            apiKey: 'sk-yyy',
            models: { 'claude-3-5-sonnet': {} },
          },
        },
        defaultLlm: 'anthropic',
        defaultAgent: 'writer',
        maxTurns: 5,
        maxAgentDepth: 2,
      };
      expect(agentConfig.defaultAgent).toBe('writer');
      expect(agentConfig.defaultLlm).toBe('anthropic');
      expect(Object.keys(agentConfig.llms!)).toHaveLength(2);
    });

    it('LlmConfig 必填 provider + models 字段', () => {
      const llm: LlmConfig = {
        provider: 'openai',
        models: { 'gpt-4o': {} },
      };
      expect(llm.provider).toBe('openai');
      expect(llm.apiKey).toBeUndefined();
      expect(llm.baseURL).toBeUndefined();
      expect(llm.models).toBeDefined();
      expect(llm.models!['gpt-4o']).toEqual({});
    });

    it('LlmConfig 支持自定义透传字段（provider 级）', () => {
      const llm: LlmConfig = {
        provider: 'openai',
        apiKey: 'sk-xxx',
        baseURL: 'https://api.openai.com/v1',
        models: {
          'gpt-4o': {},
          'gpt-4o-mini': { temperature: 0.5 },
        },
        temperature: 0.7,
        max_tokens: 4096,
      };
      expect(llm.temperature).toBe(0.7);
      expect((llm as unknown as { max_tokens: number }).max_tokens).toBe(4096);
      // model 级字段覆盖
      expect(llm.models!['gpt-4o-mini']!.temperature).toBe(0.5);
    });

    it('LlmModelConfig 接受任意 key（model 级透传字段）', () => {
      const modelCfg: LlmModelConfig = {
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 1024,
      };
      expect(modelCfg.temperature).toBe(0.5);
      expect(modelCfg.top_p).toBe(0.9);
    });

    it('agent 配置可与 cors / lifecycle 等其他字段共存', () => {
      const config: FaapiConfig = {
        cors: { origin: '*' },
        lifecycle: { onReady: async () => {} },
        agent: {
          llms: {
            openai: { provider: 'openai', apiKey: 'sk-xxx', models: { 'gpt-4o': {} } },
          },
          defaultAgent: 'researcher',
        },
        db: { host: 'localhost' },
      };
      expect(config.cors).toBeDefined();
      expect(config.lifecycle).toBeDefined();
      expect(config.agent!.defaultAgent).toBe('researcher');
      expect((config as { db: { host: string } }).db.host).toBe('localhost');
    });

    it('LlmConfig 类型校验', () => {
      expectTypeOf<LlmConfig>().toHaveProperty('provider').toBeString();
      expectTypeOf<LlmConfig>().toHaveProperty('apiKey').toEqualTypeOf<string | undefined>();
      expectTypeOf<LlmConfig>().toHaveProperty('baseURL').toEqualTypeOf<string | undefined>();
      expectTypeOf<LlmConfig>()
        .toHaveProperty('models')
        .toMatchTypeOf<Record<string, LlmModelConfig>>();
    });

    it('AgentConfig 类型校验（不含 defaultTools 字段）', () => {
      expectTypeOf<AgentConfig>()
        .toHaveProperty('llms')
        .toEqualTypeOf<Record<string, LlmConfig> | undefined>();
      expectTypeOf<AgentConfig>().toHaveProperty('defaultLlm').toEqualTypeOf<string | undefined>();
      expectTypeOf<AgentConfig>()
        .toHaveProperty('defaultAgent')
        .toEqualTypeOf<string | undefined>();
      expectTypeOf<AgentConfig>().toHaveProperty('maxTurns').toEqualTypeOf<number | undefined>();
      expectTypeOf<AgentConfig>()
        .toHaveProperty('maxAgentDepth')
        .toEqualTypeOf<number | undefined>();
      // 显式断言：已移除 defaultTools 字段
      expectTypeOf<AgentConfig>().not.toHaveProperty('defaultTools');
    });

    it('FaapiConfig.agent 类型校验', () => {
      expectTypeOf<FaapiConfig>().toHaveProperty('agent').toEqualTypeOf<AgentConfig | undefined>();
    });
  });
});
