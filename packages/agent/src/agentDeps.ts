/**
 * createAgentDeps——官方 AgentDeps 装配工厂
 *
 * 从注册表视图 + llms 配置构造完整 `AgentDeps`：插件 setup 与任务内组装/
 * 自组装共用同一装配，业务只声明差异项（`overrides`：装饰钩子、schema 富化、
 * 配置覆盖），不再逐字段复刻框架工厂的访问器拼装。
 *
 * 详见 [agentDeps.md](./agentDeps.md)。
 */

import {
  loadToolModule,
  createToolSchemaResolver,
  type AgentConfig,
  type FaapiContext,
  type LlmConfig,
  type ToolRegistry,
  type AgentRegistry,
} from '@faapi/faapi';
import type { AgentDeps, AgentRuntimeConfig } from './agent';
import { createProvider } from './provider';

/** `registries` 参数的最小结构——AppRegistries / TaskRegistriesView / 测试设施视图均可直传 */
export interface AgentDepsRegistries {
  agent: Pick<
    AgentRegistry,
    'getAgent' | 'getAgentEntry' | 'resolveAgentTools' | 'resolveSubAgents'
  >;
  tool: Pick<ToolRegistry, 'get'>;
}

/** createAgentDeps 入参 */
export interface CreateAgentDepsOptions {
  /**
   * 注册表视图（必填）——`ctx.registries`（AppRegistries）、`taskCtx.registries`
   * （只读视图）、测试设施的 `harness.registries` 均可直传
   */
  registries: AgentDepsRegistries;
  /** 请求/任务上下文透传（AgentDeps.ctx：authHooks 与 tool handler 第二参数读取） */
  ctx?: Partial<FaapiContext>;
  /** 项目根目录（loadToolModule 桥接与 schema 解析器定位用；缺省 process.cwd()） */
  rootDir?: string;
  /**
   * faapi.config 的 `agent` 块复合形状（llms + 运行时旋钮）直收——与
   * `FaapiConfig['agent']`（AgentConfig）同构，可整体透传 `ctx.config.agent` /
   * `taskCtx.config.agent` 读回值。拆装清单在本工厂单一维护（含 enableTracing
   * 全量字段），与显式 `llms` / `config` 的合并语义：显式参数优先，
   * `agentConfig` 提供底座（llms：`options.llms ?? agentConfig.llms`；
   * config：`{ ...拆装结果, ...options.config }`）
   */
  agentConfig?: AgentConfig;
  /**
   * LLM provider 配置（key 为 provider 名）。提供时逐项 `createProvider` 转换为
   * providers Map 并透传 llms（model key 解析用）；缺省为空 Map + 空 llms
   * （外部 provider 模式——`agent.run(input, { provider })` 每次显式注入）
   */
  llms?: Record<string, LlmConfig>;
  /** 全局 agent 运行时配置（maxTurns / maxAgentDepth / maxHistoryTokens / historyCompactor / 三鉴权钩子） */
  config?: AgentRuntimeConfig;
  /**
   * 差异项覆盖（浅合并，最后应用、优先级最高）——装饰钩子 / schema 富化 /
   * 单个访问器定制 / providers 直传（绕过 llms 转换）等
   */
  overrides?: Partial<AgentDeps>;
}

/**
 * `AgentConfig`（faapi.config 的 agent 块复合形状）拆装为 `AgentRuntimeConfig`
 *
 * 复合块拆装的字段清单单一来源——框架新增 `AgentConfig` 旋钮时只改本函数一处，
 * 插件 setup 与业务自组装两路自动到达（历史缺口：清单散落两端手抄，某侧漏拼
 * 即静默缺失，enableTracing 曾中招）。
 */
function toAgentRuntimeConfig(agentConfig: AgentConfig): AgentRuntimeConfig {
  return {
    maxTurns: agentConfig.maxTurns,
    maxAgentDepth: agentConfig.maxAgentDepth,
    maxHistoryTokens: agentConfig.maxHistoryTokens,
    enableTracing: agentConfig.enableTracing,
    traceId: agentConfig.traceId,
    traceIdTemplate: agentConfig.traceIdTemplate,
    beforeToolCall: agentConfig.beforeToolCall,
    afterToolCall: agentConfig.afterToolCall,
    filterTools: agentConfig.filterTools,
  };
}

/**
 * 从注册表视图 + agent 配置构造完整 AgentDeps
 *
 * 装配内容与 `@faapi/agent` 插件 setup 同构：注册表访问器透传、loadToolModule
 * 桥接（rootDir 注入）、schema 解析器（同一实例服务 tool input 与派发入参）、
 * llms → providers 转换。
 *
 * **纯装配无副作用**：不注册 handle 工厂、不建 app、不触碰全局状态。每次调用
 * 返回独立的 deps 对象（providers Map、schema 解析器缓存随 deps 生命周期）——
 * 进程级复用由调用方负责：插件 setup 调一次天然闭包单例；任务侧建议模块级
 * 创建一次（进程内任务跨执行复用；隔离 worker 每次执行新模块图，缓存随执行重建）。
 *
 * **空 apiKey 照常注册 provider**（部分网关/本地模型场景无需 key）；「key 未配置」
 * 的启动期显性提示由插件 setup 负责（本工厂可能在任务内调用，不在此处刷警告）。
 *
 * @param options registries 必填，其余可选
 */
export function createAgentDeps(options: CreateAgentDepsOptions): AgentDeps {
  const {
    registries,
    ctx,
    rootDir = process.cwd(),
    agentConfig,
    llms,
    config,
    overrides,
  } = options;

  // agentConfig 为底座、显式参数优先：llms 整体替换（??），config 字段级覆盖（spread 后置）
  const resolvedLlms: Record<string, LlmConfig> = llms ?? agentConfig?.llms ?? {};
  const resolvedConfig: AgentRuntimeConfig | undefined = agentConfig
    ? { ...toAgentRuntimeConfig(agentConfig), ...config }
    : config;
  // overrides 直传 providers 时跳过 llms 转换（外部 provider 实例注入，llms 仍透传
  // 供 model key 解析）；否则逐项 createProvider
  const providers =
    overrides?.providers ??
    (() => {
      const map = new Map<string, import('./provider').LLMProvider>();
      for (const [name, llmConfig] of Object.entries(resolvedLlms)) {
        map.set(name, createProvider(llmConfig));
      }
      return map;
    })();

  // schema 解析器：同一实例注入两个 deps（tool input 与派发入参共用缓存）——
  // overrides 覆盖时（富化包装等）以覆盖值为准
  const resolveSchema = createToolSchemaResolver({ rootDir });

  const base: AgentDeps = {
    providers,
    llms: resolvedLlms,
    rootDir,
    ...(resolvedConfig ? { config: resolvedConfig } : {}),
    ...(ctx ? { ctx } : {}),
    getAgent: (name) => registries.agent.getAgent(name),
    getAgentEntry: (name) => registries.agent.getAgentEntry(name),
    getTool: (name) => registries.tool.get(name),
    resolveAgentTools: (name) => registries.agent.resolveAgentTools(name),
    resolveSubAgents: (name) => registries.agent.resolveSubAgents(name),
    loadToolModule: (filePath, functionName) => loadToolModule(filePath, functionName, rootDir),
    resolveToolSchema: resolveSchema,
    resolveAgentInputSchema: resolveSchema,
  };

  return { ...base, ...overrides };
}
