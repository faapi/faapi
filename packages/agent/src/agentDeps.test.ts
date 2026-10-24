/**
 * createAgentDeps 单元测试——官方 deps 装配工厂的行为定义
 *
 * 详见 [agentDeps.md](./agentDeps.md)。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@faapi/faapi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@faapi/faapi')>();
  return {
    ...actual,
    loadToolModule: vi.fn(),
  };
});

vi.mock('./provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider')>();
  return {
    ...actual,
    createProvider: vi.fn(actual.createProvider),
  };
});

// ─── 导入（mock 后）─────────────────────────────────
import { createAppRegistries, createTaskRegistriesView } from '@faapi/faapi';
import type { AgentConfig, AgentMetadata, ToolMetadata } from '@faapi/faapi';
import { createAgentDeps } from './agentDeps';
import { Agent, type AgentDeps } from './agent';
import { createProvider, type LLMProvider } from './provider';
import { createScriptLLM } from './scriptLlm';

const agentEntry: AgentMetadata = {
  name: 'researcher',
  systemPrompt: '你是研究助手',
  tools: ['weather_getWeather'],
  agents: ['writer'],
  model: 'gpt-4o',
  maxTurns: 5,
  filePath: 'dist/agents/researcher/handler.js',
};

const writerEntry: AgentMetadata = {
  name: 'writer',
  systemPrompt: '你是写作助手',
  filePath: 'dist/agents/writer/handler.js',
};

const tool: ToolMetadata = {
  name: 'weather_getWeather',
  functionName: 'getWeather',
  inputTypeName: 'WeatherInput',
  filePath: 'dist/tools/weather/handler.js',
};

/** 种好数据的注册表实例（每个用例独立，互不串台） */
function makeRegistries() {
  const registries = createAppRegistries();
  registries.agent.hydrate([agentEntry, writerEntry]);
  registries.tool.hydrate([tool]);
  return registries;
}

const LLMS = {
  openai: { provider: 'openai', apiKey: 'mock-key', models: { 'gpt-4o': {} } },
};

describe('createAgentDeps', () => {
  beforeEach(() => {
    vi.mocked(createProvider).mockClear();
  });

  it('注册表访问器透传：deps 直查注册表数据', () => {
    const registries = makeRegistries();
    const deps = createAgentDeps({ registries });

    expect(deps.getAgent('researcher')?.name).toBe('researcher');
    expect(deps.getAgentEntry('researcher')?.filePath).toBe(agentEntry.filePath);
    expect(deps.getTool('weather_getWeather')?.functionName).toBe('getWeather');
    expect(deps.resolveAgentTools('researcher').map((t) => t.name)).toEqual(['weather_getWeather']);
    expect(deps.resolveSubAgents('researcher').map((a) => a.name)).toEqual(['writer']);
    expect(deps.getAgent('no-such')).toBeUndefined();
    expect(deps.getTool('no-such')).toBeUndefined();
  });

  it('TaskRegistriesView（只读视图）可直传同一最小结构', () => {
    const registries = makeRegistries();
    const view = createTaskRegistriesView(registries);
    const deps = createAgentDeps({ registries: view });

    expect(deps.getAgent('researcher')?.name).toBe('researcher');
    expect(deps.resolveAgentTools('researcher')).toHaveLength(1);
  });

  it('llms 提供时逐项转换 providers 并透传 llms', () => {
    const deps = createAgentDeps({ registries: makeRegistries(), llms: LLMS });

    expect(vi.mocked(createProvider)).toHaveBeenCalledWith(LLMS.openai);
    expect(deps.providers.get('openai')).toBeDefined();
    expect(deps.llms).toEqual(LLMS);
  });

  it('llms 缺省为外部 provider 模式：空 Map + 空 llms', () => {
    const deps = createAgentDeps({ registries: makeRegistries() });

    expect(deps.providers.size).toBe(0);
    expect(deps.llms).toEqual({});
    expect(vi.mocked(createProvider)).not.toHaveBeenCalled();
  });

  it('rootDir 缺省 process.cwd()，显式值透传', () => {
    expect(createAgentDeps({ registries: makeRegistries() }).rootDir).toBe(process.cwd());
    expect(createAgentDeps({ registries: makeRegistries(), rootDir: '/project' }).rootDir).toBe(
      '/project',
    );
  });

  it('ctx 与 config 透传', () => {
    const ctx = { currentUserId: 42 };
    const config = { maxTurns: 7, maxAgentDepth: 2 };
    const deps = createAgentDeps({ registries: makeRegistries(), ctx, config });

    expect(deps.ctx).toEqual(ctx);
    expect(deps.config).toEqual(config);
  });

  it('agentConfig 直收：复合块全量拆装——llms 转 providers，config 含 enableTracing 全字段到达', () => {
    const beforeToolCall = () => undefined;
    const afterToolCall = () => undefined;
    const filterTools = <T extends Array<unknown>>(tools: T) => tools;
    const agentConfig: AgentConfig = {
      llms: LLMS,
      maxTurns: 12,
      maxAgentDepth: 4,
      maxHistoryTokens: 30000,
      enableTracing: true,
      traceId: false,
      traceIdTemplate: 'trace: {traceId}',
      beforeToolCall,
      afterToolCall,
      filterTools,
    };
    const deps = createAgentDeps({ registries: makeRegistries(), agentConfig });

    expect(vi.mocked(createProvider)).toHaveBeenCalledWith(LLMS.openai);
    expect(deps.llms).toEqual(LLMS);
    expect(deps.providers.get('openai')).toBeDefined();
    expect(deps.config).toEqual({
      maxTurns: 12,
      maxAgentDepth: 4,
      maxHistoryTokens: 30000,
      enableTracing: true,
      traceId: false,
      traceIdTemplate: 'trace: {traceId}',
      beforeToolCall,
      afterToolCall,
      filterTools,
    });
  });

  it('agentConfig 底座 + 显式 llms/config 优先：llms 整体替换，config 字段级覆盖', () => {
    const explicitLlms = {
      openai: { provider: 'openai' as const, apiKey: 'explicit-key', models: { 'gpt-4o': {} } },
    };
    const deps = createAgentDeps({
      registries: makeRegistries(),
      agentConfig: { llms: LLMS, maxTurns: 12, enableTracing: true },
      llms: explicitLlms,
      config: { maxTurns: 7 },
    });

    // 显式 llms 整体优先（不走 agentConfig.llms）
    expect(deps.llms).toBe(explicitLlms);
    expect(deps.llms.openai.apiKey).toBe('explicit-key');
    // 显式 config 覆盖同名字段，agentConfig 未覆盖字段保留底座
    expect(deps.config?.maxTurns).toBe(7);
    expect(deps.config?.enableTracing).toBe(true);
  });

  it('agentConfig.decorateDeps 装饰生效：base 之上叠加差异项，其余装配保留', () => {
    // 业务侧按真实签名 (deps: AgentDeps) => AgentDeps 强类型书写（never[] 声明
    // 手法兼容任意函数，见 configTypes.ts 的 AgentConfig.decorateDeps JSDoc）
    const resolveSystemPrompt = async (_name: string, _meta: unknown, base: string) =>
      `${base}+配方`;
    const decorate = (deps: AgentDeps): AgentDeps => ({
      ...deps,
      resolveSystemPrompt,
    });
    const deps = createAgentDeps({
      registries: makeRegistries(),
      agentConfig: { decorateDeps: decorate },
    });

    expect(deps.resolveSystemPrompt).toBe(resolveSystemPrompt);
    // 未覆盖的装配不受装饰影响
    expect(deps.getAgent('researcher')?.name).toBe('researcher');
    expect(deps.resolveToolSchema).toBeDefined();
  });

  it('显式 overrides 优先于 decorateDeps：同名字段以 overrides 为准，未覆盖字段保留配方', () => {
    const recipeSchema = async () => undefined;
    const overrideSchema = async () => undefined;
    const decorate = (deps: AgentDeps): AgentDeps => ({
      ...deps,
      resolveToolSchema: recipeSchema,
    });
    const deps = createAgentDeps({
      registries: makeRegistries(),
      agentConfig: { decorateDeps: decorate },
      overrides: { resolveToolSchema: overrideSchema },
    });

    // 装配次序 base → decorateDeps → overrides（config 声明配方居中，显式优先）
    expect(deps.resolveToolSchema).toBe(overrideSchema);
  });

  it('decorateDeps 抛错原样冒泡（fail fast，不静默降级）', () => {
    const decorate = () => {
      throw new Error('recipe broken');
    };
    expect(() =>
      createAgentDeps({ registries: makeRegistries(), agentConfig: { decorateDeps: decorate } }),
    ).toThrow('recipe broken');
  });

  it('overrides 浅合并：装饰钩子覆盖默认装配，其余字段不受影响', () => {
    const resolveSystemPrompt = async (_name: string, _meta: unknown, base: string) =>
      `${base}+装饰`;
    const deps = createAgentDeps({
      registries: makeRegistries(),
      llms: LLMS,
      overrides: { resolveSystemPrompt },
    });

    expect(deps.resolveSystemPrompt).toBe(resolveSystemPrompt);
    // 其余装配不受覆盖影响
    expect(deps.providers.get('openai')).toBeDefined();
    expect(deps.getAgent('researcher')).toBeDefined();
  });

  it('overrides.providers 直传绕过 llms 转换（外部 provider 实例注入）', () => {
    const scripted: LLMProvider = createScriptLLM([{ content: 'ok' }]);
    const providers = new Map<string, LLMProvider>([['openai', scripted]]);
    const deps = createAgentDeps({
      registries: makeRegistries(),
      llms: LLMS,
      overrides: { providers },
    });

    expect(deps.providers).toBe(providers);
    expect(vi.mocked(createProvider)).not.toHaveBeenCalled();
    // llms 仍透传（model key 解析用）
    expect(deps.llms).toEqual(LLMS);
  });

  it('每次调用返回独立 deps（providers Map 不共享）', () => {
    const a = createAgentDeps({ registries: makeRegistries(), llms: LLMS });
    const b = createAgentDeps({ registries: makeRegistries(), llms: LLMS });

    expect(a.providers).not.toBe(b.providers);
  });

  it('装配产物直接驱动 Agent：run 一轮 scriptLLM 收敛', async () => {
    const scripted = createScriptLLM([{ content: '研究完成' }]);
    const deps = createAgentDeps({
      registries: makeRegistries(),
      overrides: { providers: new Map([['openai', scripted]]) },
    });
    const agent = new Agent(deps);

    const result = await agent.run('研究 faapi', { agent: 'researcher', provider: scripted });
    expect(result.messages.at(-1)?.content).toBe('研究完成');
    // LLM 可见 tool 列表来自注册表装配：显式 tool + sub-agent 派发名
    const toolNames = scripted.requests[0]!.tools?.map((t) => t.function.name) ?? [];
    expect(toolNames).toContain('weather_getWeather');
    expect(toolNames).toContain('agent-writer');
  });
});
