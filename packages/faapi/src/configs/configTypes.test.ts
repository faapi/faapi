import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  FaapiConfig,
  LifecycleContext,
  AgentConfig,
  LlmConfig,
  LlmModelConfig,
} from './configTypes';
import type {
  BeforeToolCallEvent,
  AfterToolCallEvent,
  FilterToolsEvent,
} from '../events/appEventBus';
import type { RouteManifest } from '../routers/routeTypes';
import type { AgentToolContext } from '../runtime/agentToolContext';
import type { Server } from 'node:http';

describe('configTypes', () => {
  it('FaapiConfig 类型可正确构造(包含所有字段)', () => {
    const config: FaapiConfig = {
      port: 3000,
      cors: { origin: '*' },
    };
    expect(config.port).toBe(3000);
  });

  it('FaapiConfig 的可选字段可以省略', () => {
    const config: FaapiConfig = {
      port: 3000,
    };
    expect(config.cors).toBeUndefined();
  });

  it('FaapiConfig 无 lifecycle 钩子类型——流程扩展经 app 事件承载', () => {
    // FaapiConfig 继承业务自定义 index signature（lifecycle 退化为普通业务 key）,
    // 钩子类型的删除以 LifecycleHooks 导入移除为编译期锚——此处锚运行时缺省
    const config: FaapiConfig = {};
    expect((config as Record<string, unknown>).lifecycle).toBeUndefined();
  });

  it('LifecycleContext 类型可正确构造', () => {
    const ctx: LifecycleContext = {
      rootDir: '/app',
      routes: [] as RouteManifest,
      server: {} as Server,
      registries: {} as import('../injection/registries').AppRegistries,
      tasks: {
        enqueue: async () => ({ id: 'test' }),
        enqueueChain: async () => ({ enqueued: true, id: 'test' }),
        resume: async () => ({ id: 'test' }),
        list: () => [],
        listQueued: async () => [],
        cancel: async () => {},
        retry: async () => {},
        enqueueGroup: async () => ({ groupId: 'test', jobs: [] }),
        getGroup: async () => undefined,
        subscribe: () => () => {},
        listEvents: () => [],
      },
      config: { answer: 42 },
    };
    expect(ctx.rootDir).toBe('/app');
    expect(ctx.routes).toEqual([]);
    // config 为 faapi.config 全量活引用（FaapiContextConfig 开放 Record）
    expect(ctx.config.answer).toBe(42);
  });

  it('app:boot / app:ready / app:close 事件载荷为 LifecycleContext（ctx 全量字段）', () => {
    type BootHandler = Parameters<import('../events/appEventBus').AppEventHandler<'app:boot'>>;
    expectTypeOf<BootHandler[0]>().toEqualTypeOf<LifecycleContext>();
    expectTypeOf<LifecycleContext['rootDir']>().toBeString();
    expectTypeOf<LifecycleContext['routes']>().toMatchTypeOf<RouteManifest>();
    expectTypeOf<LifecycleContext['server']>().toMatchTypeOf<Server>();
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
    it('FaapiConfig 支持 agent 字段（嵌套 llms，无 defaultAgent/defaultLlm）', () => {
      const config: FaapiConfig = {
        agent: {
          llms: {
            openai: {
              provider: 'openai',
              apiKey: 'sk-xxx',
              models: { 'gpt-4o': {}, 'gpt-4o-mini': { temperature: 0.5 } },
            },
          },
          maxTurns: 10,
          maxAgentDepth: 3,
        },
      };
      expect(config.agent).toBeDefined();
      expect(config.agent!.maxTurns).toBe(10);
      expect(config.agent!.maxAgentDepth).toBe(3);
      expect(config.agent!.llms!.openai.provider).toBe('openai');
      expect(config.agent!.llms!.openai.models!['gpt-4o']).toEqual({});
    });

    it('agent 字段所有子字段均可省略', () => {
      const config: FaapiConfig = {
        agent: {},
      };
      expect(config.agent).toBeDefined();
      expect(config.agent!.llms).toBeUndefined();
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
        maxTurns: 5,
        maxAgentDepth: 2,
      };
      expect(Object.keys(agentConfig.llms!)).toHaveLength(2);
      expect(agentConfig.maxTurns).toBe(5);
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
        agent: {
          llms: {
            openai: { provider: 'openai', apiKey: 'sk-xxx', models: { 'gpt-4o': {} } },
          },
          maxTurns: 5,
        },
        db: { host: 'localhost' },
      };
      expect(config.cors).toBeDefined();
      expect(config.agent!.maxTurns).toBe(5);
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

    it('AgentConfig 类型校验（无 defaultAgent / defaultLlm / defaultTools 字段）', () => {
      expectTypeOf<AgentConfig>()
        .toHaveProperty('llms')
        .toEqualTypeOf<Record<string, LlmConfig> | undefined>();
      expectTypeOf<AgentConfig>().toHaveProperty('maxTurns').toEqualTypeOf<number | undefined>();
      expectTypeOf<AgentConfig>()
        .toHaveProperty('maxAgentDepth')
        .toEqualTypeOf<number | undefined>();
      // 显式断言：字段不存在（默认 agent / 默认 provider 均在调用时显式指定）
      expectTypeOf<AgentConfig>().not.toHaveProperty('defaultTools');
      expectTypeOf<AgentConfig>().not.toHaveProperty('defaultAgent');
      expectTypeOf<AgentConfig>().not.toHaveProperty('defaultLlm');
      // AgentConfig 继承 index signature,
      // 编译期锚是 AgentRuntimeConfig 三钩子字段删除（agent 包 toAgentRuntimeConfig 拆装清单）
      expect('beforeToolCall' in ({} as AgentConfig)).toBe(false);
      expect('afterToolCall' in ({} as AgentConfig)).toBe(false);
      expect('filterTools' in ({} as AgentConfig)).toBe(false);
    });

    it('AgentConfig 无鉴权钩子字段——目录外字段不存在，事件载荷 ctx 为 AgentToolContext', () => {
      expectTypeOf<AgentConfig>().not.toHaveProperty('beforeToolCall');
      expectTypeOf<AgentConfig>().not.toHaveProperty('afterToolCall');
      expectTypeOf<AgentConfig>().not.toHaveProperty('filterTools');
      expectTypeOf<BeforeToolCallEvent['ctx']>().toEqualTypeOf<AgentToolContext>();
      expectTypeOf<AfterToolCallEvent['ctx']>().toEqualTypeOf<AgentToolContext>();
      expectTypeOf<FilterToolsEvent['ctx']>().toEqualTypeOf<AgentToolContext>();
    });

    it('FaapiConfig.agent 类型校验', () => {
      expectTypeOf<FaapiConfig>().toHaveProperty('agent').toEqualTypeOf<AgentConfig | undefined>();
    });
  });
});
