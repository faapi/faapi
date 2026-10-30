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
  type AgentToolContext,
  type LlmConfig,
  type ToolRegistry,
  type AgentRegistry,
} from '@faapi/faapi';
import { AgentError } from './agentErrors';
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
  /**
   * 执行上下文（必填，[AgentToolContext](../../faapi/src/runtime/agentToolContext.md)
   * 契约）——agent:before-tool-call 等事件订阅端与 tool handler 第二参数读取。
   * 框架三路径由框架合成
   * （HTTP 经 `toAgentToolContext` 收窄、任务路径 carry + 任务级能力合成）；
   * 测试/编程式无 app 场景用 `createStandaloneToolContext` 构造
   */
  ctx: AgentToolContext;
  /** 项目根目录（loadToolModule 桥接与 schema 解析器定位用；缺省 process.cwd()） */
  rootDir?: string;
  /**
   * faapi.config 的 `agent` 块复合形状（llms + 运行时旋钮）——唯一配置入口，
   * 可整体透传 `ctx.config.agent` / `taskCtx.config.agent` 读回值。llms 逐项
   * `createProvider` 转换 providers Map（model key 解析用），旋钮经
   * `toAgentRuntimeConfig` 全量拆装（清单单一维护，含 enableTracing /
   * toolTimeoutMs / maxHistoryTokens 等声明面旋钮）。缺省为空 Map + 无 config
   * （外部 provider 模式——`agent.run(input, { provider })` 每次显式注入）
   */
  agentConfig?: AgentConfig;
  /**
   * 差异项覆盖（浅合并，最后应用、优先级最高）——装饰钩子 / schema 富化 /
   * 单个访问器定制 / providers 直传（绕过 llms 转换）/ 测试桥接等编程级差异
   */
  overrides?: Partial<AgentDeps>;
}

/**
 * `AgentConfig`（faapi.config 的 agent 块复合形状）拆装为 `AgentRuntimeConfig`
 *
 * 复合块拆装的字段清单单一来源——框架新增 `AgentConfig` 旋钮时只改本函数一处，
 * 插件 setup 与业务自组装两路自动到达（清单若散落两端手抄，某侧漏拼即静默缺失，
 * 单一来源消除该风险）。
 */
function toAgentRuntimeConfig(agentConfig: AgentConfig): AgentRuntimeConfig {
  return {
    maxTurns: agentConfig.maxTurns,
    maxAgentDepth: agentConfig.maxAgentDepth,
    maxHistoryTokens: agentConfig.maxHistoryTokens,
    toolTimeoutMs: agentConfig.toolTimeoutMs,
    enableTracing: agentConfig.enableTracing,
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
 * @param options registries 与 ctx 必填，其余可选
 */
export function createAgentDeps(options: CreateAgentDepsOptions): AgentDeps {
  const { registries, ctx, rootDir = process.cwd(), agentConfig, overrides } = options;

  // ctx 必填的运行时保证：TS 层已强制，此处挡住绕过类型检查的 JS 调用——
  // 无 ctx 的 deps 会让 tool handler 第二参数缺席（契约破坏），显式失败不降级
  if (ctx == null || typeof ctx !== 'object') {
    throw new AgentError(
      'createAgentDeps: ctx 必填（AgentToolContext 契约）——HTTP/任务路径由框架合成，' +
        '测试与编程式场景用 createStandaloneToolContext 构造',
    );
  }

  // agentConfig 是唯一配置入口：llms 目录转 providers，旋钮全量拆装
  const resolvedLlms: Record<string, LlmConfig> = agentConfig?.llms ?? {};
  const resolvedConfig: AgentRuntimeConfig | undefined = agentConfig
    ? toAgentRuntimeConfig(agentConfig)
    : undefined;
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
    ctx,
    getAgent: (name) => registries.agent.getAgent(name),
    getAgentEntry: (name) => registries.agent.getAgentEntry(name),
    getTool: (name) => registries.tool.get(name),
    resolveAgentTools: (name) => registries.agent.resolveAgentTools(name),
    resolveSubAgents: (name) => registries.agent.resolveSubAgents(name),
    loadToolModule: (filePath, functionName) => loadToolModule(filePath, functionName, rootDir),
    resolveToolSchema: resolveSchema,
    resolveAgentInputSchema: resolveSchema,
  };

  // 进程级 deps 配方（agentConfig.decorateDeps，真实签名 (deps) => deps——
  // 主包按接受任意函数的手法声明，此处消费时收窄）：base 之上、显式 overrides
  // 之前应用（config 声明配方居中，显式优先）；抛错原样冒泡（fail fast）
  const decorate = agentConfig?.decorateDeps as ((deps: AgentDeps) => AgentDeps) | undefined;
  const decorated = decorate ? decorate(base) : base;

  return { ...decorated, ...overrides };
}
