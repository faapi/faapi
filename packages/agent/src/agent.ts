import {
  readResource,
  subAgentToolName,
  APP_EVENT,
  agentRootInputEventName,
  agentBeforeToolCallEventName,
  agentAfterToolCallEventName,
  agentFilterToolsEventName,
  agentSystemPromptEventName,
  agentSubAgentContextEventName,
} from '@faapi/faapi';
import type {
  AgentCore,
  AgentMetadata,
  AgentToolContext,
  AgentToolDescriptor,
  LlmConfig,
  ToolMetadata,
  ToolModule,
  ToolSchemaResolution,
  AppEventEmitter,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  FilterToolsEvent,
  SystemPromptEvent,
  SubAgentContextEvent,
} from '@faapi/faapi';
import type { AgentRunOptions } from './agentHandle';
import { AgentError, AgentRecursionError, AgentToolTimeoutError } from './agentErrors';
import { runWithAgentScope } from './agentScope';
import { renderPromptTemplate } from './promptTemplate';
import { createProvider } from './provider';
import type { LLMMessage, LLMProvider, LLMToolDefinition } from './provider';
import {
  createInputStaging,
  reactLoop,
  reactLoopStream,
  validateLoopHistory,
  type InputStaging,
  type ReactLoopConfig,
  type ReactLoopResult,
  type ReactLoopStreamChunk,
  type SubAgentEventEmitter,
  type SubAgentToolResult,
} from './reactLoop';
import type { AgentTraceEvent } from './trace';
import { buildTraceIdBlock, createTraceSegment, joinTraceId } from './traceId';

// schema 解析结果契约主包持有（loader 域，见 faapi 的 toolSchemaResolver.md），
// 此处 re-export 保持 `import type { ToolSchemaResolution } from '@faapi/agent'` 导入路径不变
export type { ToolSchemaResolution } from '@faapi/faapi';

/**
 * Agent 类——按 `agent.name` 查找元数据、组装 tool 列表、提供 `run` / `stream` / `asTool`
 *
 * 把 [reactLoop](./reactLoop.md) 与 faapi 核心的 agent/tool 注册表粘合起来：
 * - **组装 tool 列表**——合并 `resolveAgentTools`（agent 显式声明的 `tools`）+ sub-agent
 * - **执行 tool**——`reactLoop` 调 `executeTool(name, args)` 时，Agent 路由：
 *   - 常规 tool（声明集合精确命中）→ `loadToolModule` 加载 handler + 可选 input 校验 → 调用
 *   - sub-agent 派发名（`agent-<name>`，构建期建立的「派发名 → agent 名」映射命中）
 *     → 递归构造 sub-agent 调用（含 `maxAgentDepth` 防护）——不按名字前缀猜测路由
 * - **递归防护**——`maxAgentDepth` 限制 agent 调用 agent 的深度
 *
 * 详见 [agent.md](./agent.md)。
 */

/** 默认最大 agent 递归深度（根 agent depth=1，sub-agent 递增） */
const DEFAULT_MAX_AGENT_DEPTH = 3;

/**
 * sub-agent 工具 input 字段的默认 description（派发交接单说明）
 *
 * sub 元数据声明 `inputDescription` 时覆盖——让每个 sub-agent 自述需要什么样的交接单
 */
const DEFAULT_SUBAGENT_INPUT_DESCRIPTION =
  '派发给该 agent 的任务交接单（自然语言）：写清任务目标、必要的上下文信息与对产出结果的要求';

/**
 * 从 sub-agent tool call 的 args 提取 user 消息
 *
 * args 恰为单字段 `{ input: <string> }`（与显式入参 schema 形状一致）时直传字符串——
 * 去掉 JSON 壳，子代理 LLM 直接读交接单原文;其余形状（宽松模型多传字段/传空对象/
 * 任意 JSON）`JSON.stringify` 兜底，不丢信息、向后兼容
 */
/**
 * 派发入参 → sub-agent user 消息文本（args 恰为单字段 `{ input: <string> }` 时
 * 直传字符串,其余形状 stringify 兜底）。隔离任务宿主执行器（plugin.runAgent）对
 * 结构化顶层入参复用同一约定——与 sub-agent 派发的 user 消息构造单一来源。
 */
export function extractSubAgentUserInput(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 1 && keys[0] === 'input' && typeof args.input === 'string') {
    return args.input;
  }
  return JSON.stringify(args);
}

/**
 * 判断是否为 LLMProvider 实例（有 `complete` / `stream` 方法）
 *
 * 用于 `options.provider` 的运行时形状判别——`LLMProvider` 实例直接使用,
 * `LlmConfig` 配置对象走 `createProvider` 现场创建。
 */
function isProviderInstance(value: unknown): value is LLMProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as LLMProvider).complete === 'function' &&
    typeof (value as LLMProvider).stream === 'function'
  );
}

/**
 * 判断是否为 LlmConfig 配置对象（含字符串 `provider` 字段）
 */
function isProviderConfig(value: unknown): value is LlmConfig {
  return (
    typeof value === 'object' && value !== null && typeof (value as LlmConfig).provider === 'string'
  );
}

/**
 * 物化外部 provider（`options.provider` → LLMProvider 实例）
 *
 * - `LLMProvider` 实例 → 直接使用（自定义内部模型网关等）
 * - `LlmConfig` 配置对象 → `createProvider` 现场创建（浅拷贝 + `models` 兜底 `{}`,
 *   不改调用方对象；每次调用独立创建,无共享状态,不进 providers Map）
 * - 两者皆非 → 抛 `AgentError`（不降级猜测）
 *
 * @throws {AgentError} 形式非法（既非 LlmConfig 也非 LLMProvider）
 */
function materializeProvider(external: LlmConfig | LLMProvider): LLMProvider {
  if (isProviderInstance(external)) return external;
  if (isProviderConfig(external)) {
    return createProvider({ ...external, models: external.models ?? {} });
  }
  throw new AgentError(
    'options.provider must be an LlmConfig object (with a string "provider" field) or an LLMProvider instance (with complete/stream methods)',
  );
}

/**
 * 解析模型字符串 key → provider + model（模块级导出——Agent 与
 * [lightComplete](./lightComplete.md) 共用同一解析实现，规则见
 * [agentHandle.md](./agentHandle.md) 的「`options.model` 字符串 key 解析规则」）
 *
 * 无默认 provider——`key` 未传时用 `fallbackKey`（lightComplete 场景为 llms 第一个
 * key；Agent 场景不传 fallback——model 是调用侧决策，未传即抛 `AgentError`）；
 * 两者皆无抛 `AgentError`。
 * 1. 精确匹配 `deps.providers` 的 key → 该 provider + 其 `models` 第一个 key
 * 2. 含 `/` → `provider/model` 形式（要求该 model 在 `deps.llms[provider].models` 里）
 * 3. 不含 `/` 且非 provider key → 在所有 provider 的 `models` 里按 model 名查找
 *    - 唯一 → 该 provider + 该 model
 *    - 多个 → 抛 `AgentError`（要求用 `provider/model` 消歧）
 *    - 无 → 抛 `AgentError`
 *
 * @returns provider + provider 名（lightComplete 据此读该 provider 的 LlmConfig）+ model
 * @throws {AgentError} key 与 fallbackKey 均缺省；key 解析失败（provider/model 不存在或歧义）
 */
export function resolveModelKey(
  key: string | undefined,
  deps: { providers: Map<string, LLMProvider>; llms: Record<string, LlmConfig> },
  fallbackKey?: string,
): { provider: LLMProvider; providerName: string; model: string | undefined } {
  const effectiveKey = key ?? fallbackKey;
  if (effectiveKey === undefined) {
    throw new AgentError(
      'No LLM provider resolved: pass options.model (a provider key / "provider/model" / model name from config.agent.llms) or options.provider (external provider)',
    );
  }

  // 规则 1：精确匹配 providers key（如 'openai'）
  const byProviderKey = deps.providers.get(effectiveKey);
  if (byProviderKey) {
    const llmConfig = deps.llms[effectiveKey];
    const firstModel = llmConfig ? Object.keys(llmConfig.models)[0] : undefined;
    return {
      provider: byProviderKey,
      providerName: effectiveKey,
      model: firstModel ?? fallbackKey,
    };
  }

  // 规则 2：含 '/' → provider/model 形式（如 'openai/gpt-4o'）
  if (effectiveKey.includes('/')) {
    const slashIdx = effectiveKey.indexOf('/');
    const providerName = effectiveKey.slice(0, slashIdx);
    const modelName = effectiveKey.slice(slashIdx + 1);
    const provider = deps.providers.get(providerName);
    if (!provider) {
      throw new AgentError(
        `Unknown provider "${providerName}" in model key "${effectiveKey}". Declare it in config.agent.llms, or pass options.provider to use an external provider.`,
      );
    }
    const llmConfig = deps.llms[providerName];
    if (!llmConfig || !llmConfig.models[modelName]) {
      throw new AgentError(
        `Model "${modelName}" not found in provider "${providerName}". Declare it in config.agent.llms.${providerName}.models.`,
      );
    }
    return { provider, providerName, model: modelName };
  }

  // 规则 3：纯 model 名模糊匹配（如 'gpt-4o'）
  const matches: { provider: LLMProvider; providerName: string }[] = [];
  for (const [providerName, provider] of deps.providers) {
    const llmConfig = deps.llms[providerName];
    if (llmConfig && llmConfig.models[effectiveKey]) {
      matches.push({ provider, providerName });
    }
  }
  if (matches.length === 1) {
    return {
      provider: matches[0]!.provider,
      providerName: matches[0]!.providerName,
      model: effectiveKey,
    };
  }
  if (matches.length > 1) {
    throw new AgentError(
      `Model "${effectiveKey}" is ambiguous (found in providers: ${matches.map((m) => m.providerName).join(', ')}). Use "provider/model" to disambiguate.`,
    );
  }
  throw new AgentError(
    `Model "${effectiveKey}" not found in any provider. Declare it in config.agent.llms.*.models, or pass options.provider to use an external provider.`,
  );
}

/**
 * 校验续跑历史结构（见 reactLoop.md 中断恢复章节）
 *
 * `AgentRunOptions.messages` 是业务方持久化后回传的历史，最常见的损坏是截断在
 * 轮组中间（assistant.toolCalls 缺 tool 结果）或反序列化出非法 role——直接发给
 * LLM API 只会得到模糊的 400。此处早失败（抛 `AgentError`，不发起 LLM 请求）。
 *
 * 校验规则：
 * - role 必须是 system / user / assistant / tool 之一
 * - assistant 消息带 `toolCalls` 时，其后必须紧跟对应数量的 tool 结果消息
 *   （按 `toolCallId` 配对，在任何非 tool 消息之前）
 *
 * @throws {AgentError} 历史结构非法（消息含索引与 toolCallId，可定位损坏点）
 */
function validateResumeHistory(messages: LLMMessage[]): void {
  // 校验逻辑单一来源在 reactLoop.validateLoopHistory（超限事件 replace 产物同款约束）
  validateLoopHistory(messages, 'resume history');
}

/**
 * 全局 agent 配置覆盖
 *
 * 来自 faapi.config.ts 的 `agent` 块，提供全局默认值。
 * agent 自身 `config.maxTurns` 优先于全局配置。
 */
export interface AgentRuntimeConfig {
  /** 默认最大对话轮数（agent 自身 maxTurns 优先） */
  maxTurns?: number;
  /** agent 调用 agent 的最大递归深度（默认 3） */
  maxAgentDepth?: number;
  /**
   * 历史超限事件触发阈值（近似估算,未设置 = 不估算不发射）——透传 reactLoop,
   * 见 reactLoop.md「agent:history-over-budget 历史超限事件」章节
   */
  maxHistoryTokens?: number;
  /**
   * 单次 tool 执行的超时毫秒数（未设置 = 不限时）。超时抛 `AgentToolTimeoutError`,
   * 被 reactLoop 按既有 tool 错误路径回传 LLM（LLM 可决定重试或换路）——不限时的
   * 挂死 tool handler（如无超时的内部 fetch）会让整个 run 永久挂起,且 run 的
   * abort signal 对 tool 执行无效
   */
  toolTimeoutMs?: number;
  /**
   * 启用 tracing 的全局默认值（默认 false——opt-in,不开启零开销）。
   *
   * 开启时 `ReactLoopResult.trace` / `ReactLoopStreamChunk.traceEvent` 填充
   * 结构化调用明细,详见 [trace.md](./trace.md)。
   *
   * 单次调用可通过 `AgentRunOptions.enableTracing` 覆盖。
   */
  enableTracing?: boolean;
  /**
   * 层级追踪 ID(默认 `true`——自动生成,详见 [traceId.md](./traceId.md))
   *
   * 每次根 `run` / `stream` 自动生成 12 位十六进制段,sub-agent 派发链式续拼
   * (父完整 ID + '.' + 新段),注入最终 system 消息末尾并在结果暴露
   * (`ReactLoopResult.traceId` / 流式 `done.traceId` / `AgentTrace.traceId`)。
   *
   * `false` 整体关闭:不生成、不注入、结果无字段(逐字节回到现状);
   * 单次调用显式传 `AgentRunOptions.traceId` 时仍生效(显式优先)。
   */
  traceId?: boolean;
  /**
   * traceId 注入模板(缺省用英文默认文案,见 traceId.md)
   *
   * 必须含 `{traceId}` 占位符(渲染时替换为完整 ID),缺失抛 `AgentError`——
   * 静默渲染出无 ID 的 trace 块会让注入块失去关联能力。
   */
  traceIdTemplate?: string;
  /**
   * 执行守卫/审计/可见性过滤经 [appEventBus](../../faapi/src/events/appEventBus.md)
   * 的 `agent:before-tool-call` / `agent:after-tool-call` / `agent:filter-tools`
   * 事件承载（经 `AgentDeps.emitAppEvent` 发射,订阅入口 `getApp().on`——启动期写 `src/bootstrap.ts`）。
   */
}

/**
 * beforeToolCall 的返回守卫
 *
 * - `{ error }`：拒绝执行,error 字符串回传 LLM
 * - `{ args }`：以改写后的参数继续执行
 */
/**
 * 本次调用的解析结果（[buildLoopConfig](#buildLoopConfig) 解析后经闭包传给 executeTool）
 *
 * - `agentName`——本次调用的有效 agent 名（执行白名单按它的声明集合校验）
 * - `enableTracing`——sub-agent 调用是否在 SubAgentToolResult 上附带 trace
 * - `provider` / `model`——解析出的 LLM 入口,sub-agent 递归继承（沿用父调用解析结果）
 */
interface AgentCallContext {
  agentName: string;
  enableTracing: boolean;
  /**
   * 本次调用的层级追踪 ID(见 [traceId.md](./traceId.md))——已注入本次 system
   * 消息并在结果暴露;`executeSubAgent` 据此为子调用链式续拼子 ID。
   * `config.agent.traceId: false` 且未显式传 `options.traceId` 时 `undefined`。
   */
  traceId: string | undefined;
  provider: LLMProvider;
  model: string | undefined;
  /**
   * 声明集合二元结构（run 开始时构建一次）——执行路由按声明来源判定，不按名字
   * 前缀猜测：`declaredTools` 是 agent 声明的常规 tool 名；`agentToolNames` 是
   * sub-agent 派发工具名（`agent-<name>`，[subAgentToolName](../../faapi/src/injection/subAgentToolName.md) 生成）
   * 到真实 agent 名的映射。两集合构建期保证不相交（派发名与声明 tool 名冲突即抛错）
   * ——真工具与派发名互不误伤（filterTools 只影响 LLM 可见性，声明集合保持全量语义）
   */
  declaredTools: ReadonlySet<string>;
  agentToolNames: ReadonlyMap<string, string>;
}

/**
 * tool schema 解析结果（`ToolSchemaResolution`）已下沉主包 loader 域
 * （`@faapi/faapi` 的 toolSchemaResolver），上方 re-export 保持导入路径兼容。
 */

/**
 * Agent 运行时依赖（依赖注入）
 *
 * Agent 类**不直接 import** faapi 核心的注册表/加载器，而是通过此接口接收访问器函数。
 * 原因：
 * - **可测试**——测试传 mock 访问器，无需启动真实注册表
 * - **解耦**——Agent 类不依赖核心运行时模块
 * - **phase 边界**——Phase 3.4 实现 Agent 类逻辑，Phase 3.5 注入真实访问器
 *
 * 访问器签名与 faapi 核心对称（见 [agent.md](./agent.md) 依赖注入章节）。
 */
export interface AgentDeps {
  /** LLM provider 实例映射（key 是 provider 名，来自 config.agent.llms；未配置时为空 Map） */
  providers: Map<string, LLMProvider>;
  /** LLM provider 配置映射（含 models，用于 options.model key 解析；llms 未配置时为空对象） */
  llms: Record<string, LlmConfig>;
  /** 项目根目录（Phase 3.5 接线时用于加载器） */
  rootDir: string;
  /** 全局 agent 配置覆盖 */
  config?: AgentRuntimeConfig;
  /**
   * 执行上下文（[AgentToolContext](../../faapi/src/runtime/agentToolContext.md) 契约，必填）
   *
   * 框架三路径合成、基础字段（tasks/log/signal）保证正确：
   * - HTTP 请求：`toAgentToolContext` 收窄完整请求 ctx（@faapi/agent 插件工厂）
   * - 任务：carry + scoped TaskClient + 任务级 logger + job.signal 合成
   * - 测试/编程式：`createStandaloneToolContext`（无 app 场景的合规构造）
   *
   * 业务身份字段（currentUserId 等）经 declare module 增强本类型，随 ctx 全链
   * 传导给鉴权钩子与 tool handler 第二参数。sub-agent 递归经 deps 共享自动传导
   * （同一调用内 ctx 不变）。
   */
  ctx: AgentToolContext;
  /** 查 agent LLM 可见元数据（对应 agentRegistry.getAgent,返回 AgentCore） */
  getAgent: (name: string) => AgentCore | undefined;
  /** 查 agent 完整元数据（对应 agentRegistry.getAgentEntry,返回 AgentMetadata 含 filePath） */
  getAgentEntry: (name: string) => AgentMetadata | undefined;
  /** 查 tool 元数据（对应 toolRegistry.getTool） */
  getTool: (name: string) => ToolMetadata | undefined;
  /** 解析 agent 可用常规 tool（对应 agentRegistry.resolveAgentTools） */
  resolveAgentTools: (name: string) => ToolMetadata[];
  /** 解析 agent 可调用 sub-agent 列表（对应 agentRegistry.resolveSubAgents,返回 AgentCore[]） */
  resolveSubAgents: (name: string) => AgentCore[];
  /** 动态 import tool handler（对应 loadToolModule） */
  loadToolModule: (filePath: string, functionName: string) => Promise<ToolModule>;
  /** tool input 的 schema 解析（Phase 3.5 实现，可选） */
  resolveToolSchema?: (tool: ToolMetadata) => Promise<ToolSchemaResolution | undefined>;
  /**
   * sub-agent 派发入参 schema 解析（可选）
   *
   * sub 元数据声明 `inputTypeName`（handler.ts 顶层 `Input` 导出，构建期生成 zod.js）
   * 时解析其 JSON Schema + 校验函数——`buildToolDefinitions` 用作派发工具 parameters、
   * `executeSubAgent` 执行前校验。通常与 `resolveToolSchema` 是同一实现
   * （[createToolSchemaResolver](./toolSchemaResolver.md) 返回值同时满足两个签名）。
   * 未提供时派发一律走单字段 `input` 模式（编程式组装的向后兼容）。
   */
  resolveAgentInputSchema?: (agent: AgentMetadata) => Promise<ToolSchemaResolution | undefined>;
  /**
   * app 事件发射器（可选——`@faapi/agent` 插件经 `createAgentDeps` 的 `overrides`
   * 注入 `registries.appEvents.emit`，业务自组装可不注）
   *
   * 七个接缝经此发射 [appEventBus](../../faapi/src/events/appEventBus.md) 框架事件
   * （agent 域流程扩展事件的统一出口）：
   * - `agent:root-input` / `agent:input` / `agent:system-prompt` /
   *   `agent:sub-agent-context` / `agent:before-tool-call` / `agent:after-tool-call`
   *   （观察类留痕口径）/ `agent:filter-tools`——均含 `:<agentName>`（tool 事件为
   *   `:<toolName>`）专属名,先通用后专属同一载荷对象顺序发射
   *
   * 未注入 → 事件不发射、输入原样（能力边界,非降级）。
   * 发射器无 app 边界校验：载荷形状由调用点保证,handler 错误原样上抛走 run / stream
   * 既有错误链。
   */
  emitAppEvent?: AppEventEmitter;
}

// Agent 系统级错误家族持有于 agentErrors.ts（reactLoop 的历史压缩守卫需要抛
// AgentError,独立模块解开 reactLoop ↔ agent 循环依赖）;此处 re-export 保持
// `from './agent'` 导入路径不变
export { AgentError, AgentRecursionError, AgentToolTimeoutError } from './agentErrors';

/**
 * faapi Agent
 *
 * 组装 [reactLoop](./reactLoop.md) 配置、执行 tool、递归 sub-agent 的运行时入口。
 */
export class Agent {
  private readonly deps: AgentDeps;
  /** 当前递归深度（根 agent 为 1，sub-agent 递增） */
  private readonly depth: number;
  /**
   * tool schema 解析缓存（按 tool.name 缓存，含 undefined 结果）
   *
   * `buildToolDefinitions` 组装 LLM tool 列表时解析一次 schema（取 jsonSchema），
   * `executeTool` 执行前校验时复用同一份 schema（取 validate）——
   * 避免每次 tool 执行都重新 `loadToolSchema` + `z.toJSONSchema`。
   *
   * 实例级缓存：sub-agent 各有独立 cache（tool 集合可能不同）。
   */
  private readonly schemaCache = new Map<string, ToolSchemaResolution | undefined>();

  /**
   * 派发上下文块（父侧 `executeSubAgent` 注入,仅本次派发的子循环生效）
   *
   * `executeSubAgent` 发射 `agent:sub-agent-context` 事件后把 handler 产出
   * （payload.context）赋到**本实例**——`buildLoopConfig` 在 systemPrompt 装饰
   * 结果之后以 `\n\n` 追加为最终 system 消息。实例级字段:每次派发构造独立子
   * Agent 实例,同轮并行派发各自注入无交叉;
   * 根 Agent（编程式 `run`/`stream` 直调）恒为 `undefined`,逐字节现状。
   * 详见 [agent.md](./agent.md)「agent:sub-agent-context 派发上下文事件」。
   */
  private subAgentContextBlock: string | undefined;

  /**
   * @param deps 运行时依赖（访问器 + providers Map + llms + config）
   * @param depth 递归深度（默认 1 = 根 agent；sub-agent 递归时传入 depth+1）
   */
  constructor(deps: AgentDeps, depth: number = 1) {
    this.deps = deps;
    this.depth = depth;
  }

  /**
   * 非流式执行——组装 config 调 [reactLoop](./reactLoop.md)
   *
   * reactLoop 不知 agent 名（只关心循环逻辑）,返回的 `result.trace.agentName` 为空字符串。
   * 本方法在 reactLoop 返回后填充 `options.agent`,让顶层 trace 标识"是哪个 agent 跑的"。
   *
   * @param input 用户输入（可选——续跑场景不传新输入；input 与 `options.messages`
   *              都为空时抛 `AgentError`）
   * @param options 本次调用配置——`agent`（agent 名,必须显式传,无默认 agent）/
   *                provider（外部 provider）/ model（字符串 key）/ temperature /
   *                maxTokens / messages / enableTracing
   *                （不修改 agent 自身状态,详见 [agentHandle](./agentHandle.md)）
   * @returns 最终结果（content + messages + turns + stopReason + usage + trace?）
   * @throws {AgentError} 未传 options.agent；agent 未注册；input 与 messages 都为空；
   *                      续跑历史结构非法；provider/model 无法解析
   * @throws {ReactLoopError} 超出 maxTurns（`error.messages` 携带完整历史，可续跑）
   * @throws {AgentAbortError} 中断（`error.messages` 携带断点历史，可续跑）
   * @throws {Error} provider.complete 抛错时立即传播
   */
  async run(input?: string, options?: AgentRunOptions): Promise<ReactLoopResult> {
    const {
      agentName,
      config,
      traceId,
      input: effectiveInput,
    } = await this.buildLoopConfig(input, options);
    // 执行作用域挂载（详见 [agentScope](./agentScope.md)）：整条 reactLoop promise 链在
    // 当前 agent 作用域内——ALS 随 promise 传播，同轮 Promise.all 并发派发的每个分支
    // 各自继承；sub 换栈经 executeSubAgent → subAgent.run/stream 统一发生
    const result = await runWithAgentScope({ agentName, depth: this.depth }, () =>
      reactLoop(effectiveInput, config),
    );
    // reactLoop 不知 agent 名,在此填充顶层 trace.agentName（sub-agent 调本方法时也走此路径）
    if (result.trace) {
      result.trace.agentName = agentName;
      result.trace.traceId = traceId;
    }
    // traceId 暴露到顶层结果（与 trace.traceId 同值,见 traceId.md）
    if (traceId !== undefined) {
      result.traceId = traceId;
    }
    return result;
  }

  /**
   * 流式执行——组装 config 调 [reactLoopStream](./reactLoop.md)
   *
   * @param input 用户输入（可选——续跑场景不传新输入；input 与 `options.messages`
   *              都为空时抛 `AgentError`）
   * @param options 本次调用配置——`agent`（必须显式传）/ provider / model /
   *                temperature / maxTokens / messages
   *                （不修改 agent 自身状态,详见 [agentHandle](./agentHandle.md)）
   * @yields 流式 chunk（deltaContent / toolCall / toolResult / done）
   * @throws {AgentError} 未传 options.agent；agent 未注册；input 与 messages 都为空；
   *                      续跑历史结构非法；provider/model 无法解析
   * @throws {ReactLoopError} 超出 maxTurns（`error.messages` 携带完整历史，可续跑）
   * @throws {AgentAbortError} 中断（`error.messages` 携带断点历史，可续跑）
   * @throws {Error} provider.stream 抛错时立即传播
   */
  async *stream(input?: string, options?: AgentRunOptions): AsyncIterable<ReactLoopStreamChunk> {
    const {
      agentName,
      config,
      traceId,
      input: effectiveInput,
    } = await this.buildLoopConfig(input, options);
    // 执行作用域挂载（详见 [agentScope](./agentScope.md)）。ALS 语义：async generator
    // 体内不捕获创建时上下文——体内段落随消费方每次 next() 的上下文执行。因此逐次在
    // 作用域内驱动内层迭代器（等价 yield*，背压保持：仅消费方拉动时推进），chunk 原样
    // 转发；sub 换栈经 executeSubAgent → subAgent.stream 同一机制发生
    const iterator = reactLoopStream(effectiveInput, config)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const { value, done } = await runWithAgentScope({ agentName, depth: this.depth }, () =>
          iterator.next(),
        );
        if (done) return;
        // done chunk 附带本次 traceId（与 ReactLoopResult.traceId 同语义,见 traceId.md）;
        // 其余 chunk（delta/toolCall/traceEvent/subagentEvent）原样转发
        if (value.done && traceId !== undefined) {
          yield { ...value, done: { ...value.done, traceId } };
        } else {
          yield value;
        }
      }
    } finally {
      // 消费方提前 break / 抛错时对位 yield* 的迭代器收尾语义
      await iterator.return?.();
    }
  }

  /**
   * 把指定 agent 包装为 `AgentToolDescriptor` 供 LLM 当 tool 调用
   *
   * 与 [agentRegistry.asTool](../../faapi/src/injection/agentRegistry.md) 同构——
   * Agent 类自带此方法便于在注入器场景直接调用（不必再过注册表）。
   *
   * @param name agent 名（显式指定——无默认 agent）
   * @returns `AgentToolDescriptor` 或 `undefined`（agent 未注册）
   */
  asTool(name: string): AgentToolDescriptor | undefined {
    const meta = this.deps.getAgent(name);
    if (!meta) return undefined;
    return {
      kind: 'agent',
      name: subAgentToolName(meta.name),
      agentName: meta.name,
      description: meta.description,
      metadata: meta,
    };
  }

  // ─── 内部方法 ────────────────────────────────────────

  /**
   * 查询 tool schema（带缓存）
   *
   * `buildToolDefinitions` 与 `executeTool` 共用此方法——
   * 首次调用触发 `deps.resolveToolSchema`（加载 zod.js + 生成 JSON Schema），
   * 后续命中缓存直接返回（含 `undefined` 结果，用 `has` 区分未解析 vs 解析为空）。
   *
   * `deps.resolveToolSchema` 未提供时直接返回 `undefined`，不写缓存。
   */
  private async getToolSchema(tool: ToolMetadata): Promise<ToolSchemaResolution | undefined> {
    if (!this.deps.resolveToolSchema) return undefined;
    if (this.schemaCache.has(tool.name)) {
      return this.schemaCache.get(tool.name);
    }
    const resolved = await this.deps.resolveToolSchema(tool);
    this.schemaCache.set(tool.name, resolved);
    return resolved;
  }

  /**
   * 组装 ReactLoopConfig + 有效 agent 名（执行作用域 / trace.agentName 填充共用）
   *
   * 1. 解析有效 agent 名：`options.agent`（必须显式传——无默认 agent,不传抛 AgentError）
   * 2. 查 agent 元数据（未注册抛 AgentError）——用 `getAgent` 拿 AgentCore
   *    (LLM-facing 字段:systemPrompt / maxTurns)
   * 3. buildToolDefinitions 组装 tool 列表（用有效 agent 名查 tools / sub-agents）
   * 4. config 字段优先级（高 → 低）：`options` > agent 元数据 > 全局 AgentRuntimeConfig
   *
   * `options.provider`（外部 provider）存在时由 {@link resolveExternalProvider} 物化,
   * 优先级最高——`options.model` 变为原始 model 名原样透传（不解析 llms key）。
   * 否则 `options.model` 是字符串 key,由 {@link resolveModelKey} 解析为 provider + model
   * （支持 llms key 精确匹配 / `provider/model` 一体化 / 纯 model 名模糊匹配）；
   * `options.model` 未传时无 fallback,抛 `AgentError`——模型是调用侧决策。
   * 详见 [agentHandle.md](./agentHandle.md) 的「`options.model` 字符串 key 解析规则」。
   *
   * **输入守卫**（续跑入口,见 [reactLoop.md](./reactLoop.md) 中断恢复章节）：
   * `input` 与 `options.messages` 都为空时抛 `AgentError`（不发送空请求）；
   * `options.messages` 提供时先经 `validateResumeHistory` 结构校验,非法抛
   * `AgentError`,不发起 LLM 请求。
   */
  /**
   * 构建声明集合：agent 声明的常规 tool 名 + sub-agent 派发名映射
   *
   * 每次 run 构建一次存入 callCtx（executeTool 复用）——reload 场景注册表换代后
   * 新 run 重新构建，声明变化自然生效。派发名经 subAgentToolName 生成（agent 名
   * 非法在此抛错）；派发名与声明 tool 名冲突显式抛 AgentError——静默遮蔽会让
   * 其中一方不可达
   *
   * @throws {AgentError} 派发名与声明的常规 tool 名相同（改名 tool 或 sub-agent）
   */
  private buildDeclaredTools(agentName: string): {
    declaredTools: ReadonlySet<string>;
    agentToolNames: ReadonlyMap<string, string>;
  } {
    const declared = new Set<string>();
    for (const tool of this.deps.resolveAgentTools(agentName)) {
      declared.add(tool.name);
    }
    const agentToolNames = new Map<string, string>();
    for (const sub of this.deps.resolveSubAgents(agentName)) {
      const toolName = subAgentToolName(sub.name);
      if (declared.has(toolName)) {
        throw new AgentError(
          `Sub-agent dispatch tool name "${toolName}" collides with declared tool "${toolName}" in agent "${agentName}" — ` +
            'rename the tool or the sub-agent (one of them would be silently unreachable)',
        );
      }
      agentToolNames.set(toolName, sub.name);
    }
    return { declaredTools: declared, agentToolNames };
  }

  private async buildLoopConfig(
    input: string | undefined,
    options?: AgentRunOptions,
  ): Promise<{
    agentName: string;
    /** 本次 user 输入原文（undefined = 纯续跑）——root-input 塑形经 addInput 在 loop 首轮落账,不改写此值 */
    input: string | undefined;
    config: ReactLoopConfig;
    traceId: string | undefined;
  }> {
    // 输入守卫：全新对话必须有 input,续跑必须有 messages（空 input + messages = 纯续跑）
    if (!input && !options?.messages?.length) {
      throw new AgentError(
        'agent.run/stream requires non-empty input, or options.messages to resume from (AgentAbortError.messages / ReactLoopError.messages / previous result.messages)',
      );
    }
    if (options?.messages?.length) {
      validateResumeHistory(options.messages);
    }

    // 无默认 agent——options.agent 必须显式传
    const agentName = options?.agent;
    if (!agentName) {
      throw new AgentError(
        'agent.run/stream requires options.agent (no default agent) — pass { agent: "name" } to specify which agent to run',
      );
    }
    const meta = this.deps.getAgent(agentName);
    if (!meta) {
      throw new AgentError(`Agent "${agentName}" is not registered`);
    }

    // 对话首条 user 消息事件（agent:root-input,见主包 events/appEventBus.md 与
    // agent.md 同名章节）：传入非空 input 时触发（任意 depth——depth 1 为根调用输入,
    // depth ≥ 2 为子代理派发的首条 user 消息;纯续跑无新输入不触发）。写面只有
    // addInput——暂存器与 loop 首轮 agent:input 共用（挂在 appEvent.rootInputStaging,
    // reactLoop 首轮直接复用同一数组续接片段,两路一起排序 / 拼接 / {{rawInput}} 展开,
    // 落账为一条首条 user 消息）;input 只读（getter-only）,原输入恒在消息中。
    // 通用名与专属名（agent:root-input:<agentName>）同一载荷对象先通用后专属顺序发射;
    // 载荷不含 agent 名（按 agent 路由统一走专属名订阅,agent 名在事件名里——避免
    // 「载荷 agentName 分流」与「专属名订阅」两条等价路径并存的使用困惑）。handler
    // 抛错原样上抛走 run/stream 既有错误链（尚未落账,历史零污染）;emitAppEvent
    // 未接线（未加载 @faapi/agent 插件 / 编程式裸 Agent）时事件不发射、输入原样
    // （能力边界,非降级）
    let rootInputStaging: InputStaging | undefined;
    if (this.deps.emitAppEvent && input) {
      const rootInput = input;
      const staging = createInputStaging();
      const payload = {
        get input(): string {
          return rootInput;
        },
        addInput: staging.addInput,
        ctx: this.deps.ctx,
      };
      await this.deps.emitAppEvent(APP_EVENT.agentRootInput, payload);
      await this.deps.emitAppEvent(agentRootInputEventName(agentName), payload);
      rootInputStaging = staging;
    }

    // 声明集合先于 tool 列表构建——派发名冲突 / agent 名非法在发起 LLM 请求前显式失败
    const { declaredTools, agentToolNames } = this.buildDeclaredTools(agentName);
    const tools = await this.buildToolDefinitions(agentName);

    // 解析 provider + model：options.provider（外部 provider）优先级最高,存在时跳过
    // options.model 的 llms key 解析（model 原样透传）；否则按字符串 key 规则解析
    const { provider, model } =
      options?.provider !== undefined
        ? this.resolveExternalProvider(options.provider, options?.model)
        : this.resolveModelKey(options?.model);

    // 闭包捕获 enableTracing,通过 executeTool 传递给 executeSubAgent,使其决定是否附带 trace
    // enableTracing 优先级:options > deps.config > 默认 false（opt-in,零开销）
    const enableTracing = options?.enableTracing ?? this.deps.config?.enableTracing ?? false;

    // traceId 解析（见 traceId.md）：options.traceId（显式,最高——全局关闭也生效）
    // > 全局开启时自动生成（默认 true,12 位十六进制段）> 关闭且未显式传 =
    // undefined（不生成、不注入、结果无字段,逐字节现状）
    const traceId =
      options?.traceId || (this.deps.config?.traceId !== false ? createTraceSegment() : undefined);

    // 本次调用的解析结果——executeTool / executeSubAgent 复用（路由按声明来源判定,
    // sub-agent 递归继承 provider/model;traceId 供 executeSubAgent 链式续拼子 ID）
    const callCtx: AgentCallContext = {
      agentName,
      enableTracing,
      traceId,
      provider,
      model,
      declaredTools,
      agentToolNames,
    };

    // systemPromptFile：每次 run 读文件内容作为 systemPrompt（不走缓存——dev 改
    // prompt 文件经 watcher 增量复制后立即生效，无需 reload）。读取经主包免传参
    // readResource（读取根在 app 启动时绑定、隔离 worker 播种），越界/缺失显式抛
    // AgentError,不静默降级为空提示词。agent config 声明 vars 时 base 在
    // resolveSystemPrompt 内做模板渲染（{{key}} 占位符,见 promptTemplate.md）。
    // 派发上下文块（agent:sub-agent-context 事件产出,父侧 executeSubAgent 注入本
    // 实例）在其后以 \n\n 追加——undefined/空串跳过,详见 agent.md
    // 「agent:sub-agent-context 派发上下文事件」
    const systemPrompt = await this.resolveSystemPrompt(agentName, meta);
    const withContextBlock = this.subAgentContextBlock
      ? [systemPrompt, this.subAgentContextBlock].filter(Boolean).join('\n\n')
      : systemPrompt;

    // traceId 注入块（框架级元数据,不经 resolveSystemPrompt 装饰）——追加在最终
    // system 消息末尾（subAgentContextBlock 之后,业务 prompt 原样保留）。最终
    // system 为空时不注入（不凭空多出只含元数据的 system 消息,见 traceId.md
    // 「两个不注入场景」——续跑历史自带 system 时本次 systemPrompt 本就不被采用）
    const finalSystemPrompt =
      withContextBlock && traceId !== undefined
        ? `${withContextBlock}\n\n${buildTraceIdBlock(traceId, this.deps.config?.traceIdTemplate)}`
        : withContextBlock;

    return {
      agentName,
      traceId,
      input,
      config: {
        provider,
        systemPrompt: finalSystemPrompt,
        model,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        maxTurns: meta.maxTurns ?? this.deps.config?.maxTurns,
        maxHistoryTokens: this.deps.config?.maxHistoryTokens,
        tools,
        signal: options?.signal,
        messages: options?.messages,
        enableTracing,
        // agent:input 用户输入发送前事件（仅 loop 首轮非空 input 发射——工具轮 /
        // 纯续跑轮不发射、不虚构新增 user 消息,见 reactLoop.md 同名章节）——
        // emitAppEvent 未接线时不携带,循环零开销;rootInputStaging 为 agent:root-input
        // 的暂存器,loop 首轮 agent:input 复用同一数组,两路片段一起落账
        appEvent: this.deps.emitAppEvent
          ? {
              emit: this.deps.emitAppEvent,
              agentName,
              depth: this.depth,
              ctx: this.deps.ctx,
              rootInputStaging,
            }
          : undefined,
        executeTool: async (name, args, eventEmitter) =>
          this.executeTool(name, args, callCtx, eventEmitter),
      },
    };
  }

  /**
   * 解析 systemPrompt：声明 `systemPromptFile` 时读 resources 文件内容，否则用内联值
   *
   * 经主包免传参 `readResource` 读取（相对产物 resources 目录，越界/符号链接逃逸
   * 防护内建；读取根在 app 启动时绑定、隔离 worker 由 wrapper 播种，见主包
   * utils/readResource.md）。启动期已保证 systemPrompt 与 systemPromptFile 二选一
   * ——读取失败（未绑定 / 文件缺失 / 越界）抛 `AgentError`，不静默降级。
   *
   * agent config 声明 `vars` 时（提示词模板注入,见 promptTemplate.md）base 在
   * `agent:system-prompt` 装饰事件之前做模板渲染——`{{key}}` 占位符按 meta.vars 填充
   * （静态字面量,构建期提取),
   * 缺失/非法占位符抛错包装为 `AgentError`（带 agent 名）,不发起 LLM 请求;未声明时
   * 完全不渲染（逐字节现状）。
   *
   * `agent:system-prompt` 事件已接线（emitAppEvent 注入）时在 base 之上发射装饰事件
   * （handler 收到的是 vars 渲染后的内容）,返回值即最终 system 消息——每次 run /
   * 派发新鲜调用,子代理经同一 deps 全树生效;未接线时原样返回 base（逐字节现状）。
   * reactLoop 对 systemPrompt 按
   * truthy 处理,内联缺省 `''` 与缺省 undefined 行为一致（不插 system 消息）。
   */
  private async resolveSystemPrompt(agentName: string, meta: AgentCore): Promise<string> {
    let base: string;
    if (typeof meta.systemPrompt === 'function') {
      // 工厂函数形态：每次 run 求值（与 systemPromptFile「每次 run 读文件」语义
      // 对齐——按 env/DB 等运行时状态切换人设）。返回非 string 显式抛 AgentError
      // （启动期无法验证工厂返回类型，run 期兜底）。
      let rendered: string | Promise<string>;
      try {
        rendered = meta.systemPrompt();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new AgentError(`Agent "${agentName}" systemPrompt factory threw — ${reason}`);
      }
      const resolved = await rendered;
      if (typeof resolved !== 'string') {
        throw new AgentError(
          `Agent "${agentName}" systemPrompt factory must return string — got ${typeof resolved}`,
        );
      }
      base = resolved;
    } else if (!meta.systemPromptFile) {
      base = meta.systemPrompt ?? '';
    } else {
      try {
        base = await readResource(meta.systemPromptFile, 'utf-8');
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new AgentError(
          `Agent "${agentName}" systemPromptFile read failed: ${meta.systemPromptFile} (${reason}) — ` +
            'the file must exist under the runtime resources dir (src/resources/, copied into the dist by dev/build)',
        );
      }
    }
    if (meta.vars !== undefined) {
      try {
        base = renderPromptTemplate(base, meta.vars);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new AgentError(`Agent "${agentName}" systemPrompt vars render failed — ${reason}`);
      }
    }
    // agent:system-prompt 装饰事件：handler
    // 改写 payload.prompt 即最终 system 消息;载荷不含 agent 名（专属名按 agent 路由,
    // 名字在事件名里）;handler 抛错原样上抛走 run/stream 既有错误链（传播口径）;
    // 未接线时原样返回 base（逐字节现状）
    if (this.deps.emitAppEvent) {
      const payload: SystemPromptEvent = { prompt: base, ctx: this.deps.ctx };
      await this.deps.emitAppEvent(APP_EVENT.agentSystemPrompt, payload);
      await this.deps.emitAppEvent(agentSystemPromptEventName(agentName), payload);
      return payload.prompt;
    }
    return base;
  }

  /**
   * 解析外部 provider（`options.provider`）→ provider + model
   *
   * 规则见 [agentHandle.md](./agentHandle.md) 的「`options.provider` 外部 provider」章节：
   * - `LLMProvider` 实例 → 直接使用,`modelKey` 原样透传（可为 `undefined`,自定义 provider 自决）
   * - `LlmConfig` 配置对象 → `createProvider` 现场创建,`modelKey` 原样透传；
   *   缺省回落该 config `models` 第一个 key,两者皆无抛 `AgentError`（早失败,不发请求）
   * - `modelKey` 不做 llms key 解析、不拆 `/`（支持 OpenRouter 等带斜杠的 model id）
   *
   * 仅本次调用生效：不进 providers Map、sub-agent 递归不继承（executeSubAgent 构造
   * subDeps 时不携带 options,sub-agent 走默认解析链路）。
   *
   * @throws {AgentError} provider 形式非法；LlmConfig 形式下 model 缺失
   */
  private resolveExternalProvider(
    external: LlmConfig | LLMProvider,
    modelKey: string | undefined,
  ): { provider: LLMProvider; model: string | undefined } {
    const provider = materializeProvider(external);
    if (isProviderInstance(external)) {
      return { provider, model: modelKey };
    }
    const firstModel = Object.keys(external.models ?? {})[0];
    const model = modelKey ?? firstModel;
    if (model === undefined) {
      throw new AgentError(
        'External provider requires a model: pass options.model or declare models in the provider config',
      );
    }
    return { provider, model };
  }

  /**
   * 解析 `options.model` 字符串 key → provider + model（模块级 [resolveModelKey] 的
   * Agent 方法包装——无 fallback，与 [lightComplete](./lightComplete.md) 共用同一解析实现）
   *
   * @throws {AgentError} `key` 缺省；key 解析失败（provider/model 不存在或歧义）
   */
  private resolveModelKey(key: string | undefined): {
    provider: LLMProvider;
    model: string | undefined;
  } {
    return resolveModelKey(key, this.deps);
  }

  /**
   * 组装 LLM 可见 tool 列表（OpenAI chat completions 规范形）
   *
   * 合并两个来源（按 `function.name` 去重，先入者保留）：
   * 1. **resolveAgentTools** —— agent 显式声明的 `tools` 引用
   * 2. **sub-agent** —— `resolveSubAgents` 每个经 subAgentToolName 包装为 `agent-<name>`
   *
   * 每个常规 tool 的 `function.parameters`：
   * - `resolveToolSchema` 提供 → 用其 `jsonSchema`
   * - 未提供 / tool 无 `inputTypeName` → 自由 schema `{ type: 'object' }`
   *
   * sub-agent 的 `function.parameters` 按「派发入参 schema 声明」二选一：
   * - **富 schema 模式**——sub 元数据声明 `inputTypeName`（handler.ts 顶层 `Input`
   *   导出）且 `resolveAgentInputSchema` 已接线 → 用解析出的 JSON Schema（结构性
   *   交接单,字段 JSDoc 即主控可见参数描述）。声明了但解析为 `undefined` 是产物
   *   异常（dev/prod 全量生成下 zod.js 不可能合法缺失）,抛 `AgentError` 不静默降级
   * - **单字段 `input` 模式**——未声明 `Input` 或 resolver 未接线 → 显式单字段
   *   schema（string,必填）——严格遵循 JSON schema 的模型对无属性 `{ type: 'object' }`
   *   只回 `{}`,派发上下文传不进子代理;description 用 sub 元数据 `inputDescription`,
   *   未声明用默认文案
   */
  private async buildToolDefinitions(agentName: string): Promise<LLMToolDefinition[]> {
    const definitions = new Map<string, LLMToolDefinition>();

    // 1. resolveAgentTools（agent 显式声明的 tools 引用）
    for (const tool of this.deps.resolveAgentTools(agentName)) {
      if (definitions.has(tool.name)) continue;
      const schemaRes = await this.getToolSchema(tool);
      definitions.set(tool.name, {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: schemaRes?.jsonSchema ?? { type: 'object' },
        },
      });
    }

    // 2. sub-agent（经 subAgentToolName 包装为 agent-<name>；与声明 tool 名的冲突
    // 已在 buildDeclaredTools 构建期抛错，此处重名仅剩重复声明折叠）
    for (const subAgent of this.deps.resolveSubAgents(agentName)) {
      const name = subAgentToolName(subAgent.name);
      if (definitions.has(name)) continue;
      definitions.set(name, {
        type: 'function',
        function: {
          name,
          description: subAgent.description,
          parameters: await this.getSubAgentParameters(subAgent),
        },
      });
    }

    // 可见性过滤（agent:filter-tools 事件）：无权 tool 不进 LLM 的 tools 清单
    // （每次 run/stream 生效）
    const defs = Array.from(definitions.values());
    // agent:filter-tools 事件：LLM 可见清单
    // 组装末尾发射,handler 原地 filter/splice（载荷不含 agent 名,专属名按 agent
    // 路由——名字在事件名里）。只影响可见性不拦执行;handler 抛错原样上抛（传播口径）;
    // 未接线时清单原样
    if (this.deps.emitAppEvent) {
      const payload: FilterToolsEvent = { tools: defs, ctx: this.deps.ctx };
      await this.deps.emitAppEvent(APP_EVENT.agentFilterTools, payload);
      await this.deps.emitAppEvent(agentFilterToolsEventName(agentName), payload);
      return payload.tools;
    }
    return defs;
  }

  /**
   * 解析 sub-agent 派发工具的 parameters（富 schema / 单字段 input 二选一）
   *
   * 富 schema 判定需要完整元数据的 `inputTypeName`（`AgentCore` 不含）——经
   * `getAgentEntry` 查询；未声明或 `resolveAgentInputSchema` 未接线时返回单字段
   * `input` schema（历史行为,完全向后兼容）。`inputDescription` 仍从 `AgentCore`
   * 读取（LLM 可见字段的既定来源）。
   *
   * @throws {AgentError} 声明了 `inputTypeName` 且 resolver 已接线但解析为
   *   `undefined`（zod.js 缺失/损坏的产物异常,不静默退回单字段模式）
   */
  private async getSubAgentParameters(
    subAgent: AgentCore,
  ): Promise<LLMToolDefinition['function']['parameters']> {
    const entry = this.deps.getAgentEntry(subAgent.name);
    if (!entry?.inputTypeName || !this.deps.resolveAgentInputSchema) {
      return {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: subAgent.inputDescription ?? DEFAULT_SUBAGENT_INPUT_DESCRIPTION,
          },
        },
        required: ['input'],
      };
    }
    const schemaRes = await this.deps.resolveAgentInputSchema(entry);
    if (!schemaRes) {
      throw new AgentError(
        `Sub-agent "${subAgent.name}" declares input schema "${entry.inputTypeName}" but its zod.js artifact is missing or broken (run \`faapi build\` / restart \`faapi dev\` to regenerate)`,
      );
    }
    return schemaRes.jsonSchema;
  }

  /**
   * tool 执行路由（由 reactLoop 调用）
   *
   * 按声明来源路由（不按名字前缀猜测）：
   * - `agentToolNames` 命中 → {@link executeSubAgent} 递归（含 usage/turns 上卷 + tracing 包装）
   * - `declaredTools` 命中 → `loadToolModule` 加载 handler + 可选 input 校验 → 调用
   * - 两者皆未命中 → 拒绝（错误回传 LLM）
   *
   * `callCtx` 由 [buildLoopConfig](#buildLoopConfig) 闭包捕获传入——本次调用的有效
   * agent 名（声明集合）、enableTracing（sub-agent tracing 包装）与解析出的
   * provider/model（sub-agent 递归继承）。常规 tool 不需要 tracing 包装,直接返回结果。
   *
   * **常规 tool 校验失败**：不抛错，返回 `{ error }` 对象——reactLoop stringify 后
   * 作为 tool 结果回传 LLM，LLM 可据此修正参数重试。
   *
   * **tool 未找到 / 加载失败**：抛错，被 reactLoop catch 后同样回传 LLM。
   */
  private async executeTool(
    rawName: string,
    rawArgs: Record<string, unknown>,
    callCtx: AgentCallContext,
    eventEmitter?: SubAgentEventEmitter,
  ): Promise<unknown | SubAgentToolResult> {
    const name = rawName;
    let args = rawArgs;

    // ctx 声明即校验（先于 beforeToolCall 守卫）：ctx 装配错误是编程/装配问题，
    // 不应流进业务钩子——钩子只应面对合成正确的 ctx 做业务鉴权。仅真工具派发
    // 校验（sub-agent 派发名不入 tool 表，其入参校验在 executeSubAgent）；未声明
    // 工具同样先过 ctx 门禁（装配问题优先暴露，白名单拒绝仍在钩子后兜底）。
    // schemaCache 传实例缓存——与 executeToolCall 的二次校验共用「同一 tool 只
    // 解析一次」语义
    if (!callCtx.agentToolNames.has(name)) {
      const tool = this.deps.getTool(name);
      if (tool) {
        const ctxError = await validateToolCtx(
          this.deps,
          name,
          tool,
          this.deps.ctx,
          this.schemaCache,
        );
        if (ctxError) return { error: ctxError };
      }
    }

    // 执行守卫事件（agent:before-tool-call）：
    // 在 ctx 声明即校验之后、sub-agent 分流之前——一个事件同时覆盖常规 tool 与
    // sub-agent 递归。handler 原地改写 args / 设置 error（载荷不含 tool 名,专属名
    // agent:before-tool-call:<toolName> 承载按 tool 路由——名字在事件名里）;扇出后
    // 统一判定:error 非空不执行目标（error 回传 LLM）,否则以（可能改写的）payload.args
    // 继续。handler 抛错原样上抛被 per-tool catch 回传主控 LLM（传播口径）;
    // emitAppEvent 未接线时不发射、参数原样（能力边界,非降级）
    if (this.deps.emitAppEvent) {
      const payload: BeforeToolCallEvent = { args, ctx: this.deps.ctx };
      await this.deps.emitAppEvent(APP_EVENT.agentBeforeToolCall, payload);
      await this.deps.emitAppEvent(agentBeforeToolCallEventName(name), payload);
      if (payload.error !== undefined) return { error: payload.error };
      args = payload.args;
    }

    // 执行白名单：只允许 agent 声明的 tools / sub-agents。`tools`/`agents` 声明不只是
    // LLM 可见性过滤——LLM 幻觉或被提示注入时可能请求未声明的任意已注册 tool
    // （如管理类 tool）,执行前按声明集合强制校验,未声明一律拒绝（错误回传 LLM,
    // 与参数校验失败语义一致）。sub-agent 递归时每个 depth 层按自己的声明集合校验。
    // 路由按声明来源判定（declaredTools 与 agentToolNames 构建期保证不相交）——
    // 真工具 `agent-foo` 与 sub-agent `foo` 的派发名 `agent-foo` 互不误伤
    if (!callCtx.declaredTools.has(name) && !callCtx.agentToolNames.has(name)) {
      return {
        error: `Tool "${name}" is not declared by agent "${callCtx.agentName}" (add it to the agent's tools/agents declaration)`,
      };
    }

    // sub-agent 递归（映射取真实 agent 名;携带 callCtx,使其能继承 provider/model +
    // 决定是否附带 trace;eventEmitter 由流式父循环下发——嵌套循环中间事件经此冒泡,
    // 见 reactLoop.md）
    const subName = callCtx.agentToolNames.get(name);
    if (subName !== undefined) {
      return await this.executeSubAgent(subName, args, callCtx, eventEmitter);
    }

    // 常规 tool：执行半段（getTool → schema 校验 → handler → afterToolCall）抽为
    // 模块级 executeToolCall——与隔离任务宿主侧工具执行器共用同一实现
    // （schemaCache 传实例缓存，保持"同一 tool 只解析一次"语义）
    return executeToolCall(this.deps, name, args, this.deps.ctx, this.schemaCache);
  }

  /**
   * sub-agent 递归执行
   *
   * 1. `maxAgentDepth` 防护——超限抛 {@link AgentRecursionError}
   * 2. **派发入参校验（富 schema 模式）**——sub 元数据声明 `inputTypeName` 且
   *    `resolveAgentInputSchema` 已接线时执行前 `validate(args)`：失败返回
   *    `{ error }` 回灌主控 LLM 重试（与常规 tool 校验失败同语义,不进入子循环——
   *    省掉一次注定失败的子 agent 轮次）;通过后以 coerce 后的 value 继续传导。
   *    声明了但解析为 `undefined`（zod.js 缺失/损坏）抛 `AgentError` 显式失败;
   *    resolver 未接线或未声明 `Input` 时跳过校验
   *    输入塑形经 `agent:root-input` / `agent:root-input:<subName>` 事件在子循环
   *    buildLoopConfig 承接（args 本身不被改写,订阅端经 addInput 围绕提取后的
   *    user 输入字符串塑形,见 agent.md 事件章节）
   * 3. 调 `subAgent.run(stringify(args), { agent, provider, model, enableTracing })`
   *    走默认 reactLoop——provider/model 沿用父调用解析结果
   *
   * **返回值统一包装为 [SubAgentToolResult](./reactLoop.md)**（无论 tracing 开关——
   * 用量上卷不依赖 tracing）：`usage` / `turns` 是子循环整树口径（sub-sub 已在子循环
   * 上卷）,reactLoop 识别后累加进父循环,父 run 的 usage 台账 = 全部 `llm_call` 之和。
   * `enableTracing=true` 时再附 `trace`（agentName 已被 `Agent.run` 填为 subName）,
   * reactLoop 据此发出 `subagent_call` 事件,嵌入 sub-trace（递归结构,业务方可还原
   * 完整调用树）。详见 reactLoop.md「usage 与 turns 的整树口径」。
   *
   * sub-agent 统一走默认 reactLoop（agent 为声明式执行）。
   * user 消息：args 恰为单字段 `{ input: <string> }`（与显式入参 schema 形状一致）
   * 时直传字符串,其余形状 stringify 兜底（见 `extractSubAgentUserInput`）。
   */
  /**
   * agent:after-tool-call 事件发射（sub-agent 派发成功返回后,流式/非流式两分支共用;
   * 观察类留痕口径——见模块级 emitAfterToolCallEventOnDeps 同名语义）
   */
  private emitAfterToolCallEvent(
    name: string,
    args: Record<string, unknown>,
    result: unknown,
  ): void {
    emitAfterToolCallEventOnDeps(this.deps, name, args, result);
  }

  private async executeSubAgent(
    subName: string,
    rawArgs: Record<string, unknown>,
    callCtx: AgentCallContext,
    eventEmitter?: SubAgentEventEmitter,
  ): Promise<unknown | SubAgentToolResult> {
    const newDepth = this.depth + 1;
    const maxDepth = this.deps.config?.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH;
    if (newDepth > maxDepth) {
      throw new AgentRecursionError(maxDepth, newDepth);
    }

    // 派发入参校验（富 schema 模式）——beforeToolCall 守卫改写后的 args 也在此校验
    let args = rawArgs;
    const entry = this.deps.getAgentEntry(subName);
    if (entry?.inputTypeName && this.deps.resolveAgentInputSchema) {
      const schemaRes = await this.deps.resolveAgentInputSchema(entry);
      if (!schemaRes) {
        throw new AgentError(
          `Sub-agent "${subName}" declares input schema "${entry.inputTypeName}" but its zod.js artifact is missing or broken (run \`faapi build\` / restart \`faapi dev\` to regenerate)`,
        );
      }
      const result = schemaRes.validate(args);
      if (!result.ok) {
        // 校验失败：返回 { error } 对象,不进入子循环——错误回传主控 LLM 重试
        return { error: result.error };
      }
      args = result.value ?? args;
    }

    // 派发工具名（subagentEvent 冒泡标识 + afterToolCall 审计名,即 LLM 看到的名字）
    const toolName = subAgentToolName(subName);

    // 构造子 agent（复用父 deps——providers/llms/访问器共享,无 per-agent 名绑定）
    const subAgent = new Agent(this.deps, newDepth);

    // 继承父调用的 provider 与 model（sub-agent 不声明模型,恒沿用父调用解析
    // 结果）。单字段 { input } 直传字符串（与显式入参 schema 形状一致),
    // 其余形状 stringify 兜底;传递 enableTracing 让 sub-agent 采集 trace。
    // traceId 链式续拼（见 traceId.md）：子 ID = 父完整 ID + '.' + 新段;父调用
    // traceId 关闭（undefined）时子调用同样无——关闭语义整树一致
    const subOptions: AgentRunOptions = {
      agent: subName,
      provider: callCtx.provider,
      model: callCtx.model,
      enableTracing: callCtx.enableTracing,
      traceId:
        callCtx.traceId !== undefined
          ? joinTraceId(callCtx.traceId, createTraceSegment())
          : undefined,
    };

    // 派发入参塑形经 agent:root-input 事件：子循环 buildLoopConfig 对非空 input
    // 发射,handler 经 addInput 围绕提取后的 user 输入字符串塑形（见 buildLoopConfig
    // 内 agent:root-input 接缝）——派发塑形诉求由 `agent:root-input:<subName>` 专属
    // 订阅承接

    // agent:sub-agent-context 事件（见 agent.md 同名章节）：派发入参校验通过后发射
    // （args 已过校验,原样传导——输入改写发生在子循环事件接缝,不改 args）,handler
    // 设置 payload.context 追加进子代理 system——产出注入**本子 Agent 实例**,子循环
    // buildLoopConfig 在 systemPrompt 装饰结果之后以 \n\n 追加为最终 system 消息
    // （不设/空串跳过,多 handler 后设覆盖）;handler 抛错原样上抛被 per-tool catch
    // 回传主控 LLM（传播口径）;未接线时不发射。调用先于流式/非流式分支分流——两分支
    // 同一接线。每次派发独立子 Agent 实例,同轮并行派发各自注入无交叉
    if (this.deps.emitAppEvent) {
      const payload: SubAgentContextEvent = {
        args,
        context: undefined,
        ctx: this.deps.ctx,
      };
      await this.deps.emitAppEvent(APP_EVENT.agentSubAgentContext, payload);
      await this.deps.emitAppEvent(agentSubAgentContextEventName(subName), payload);
      subAgent.subAgentContextBlock = payload.context;
    }

    // 流式父循环（eventEmitter 存在）：子循环也跑流式,子循环的中间事件（LLM 增量、
    // tool 调用/结果——含其派发孙代理的调用）经 emitter 实时冒泡为父流的
    // subagentEvent chunk（reasoning 仅透出不进历史,与 thinking 剥离纪律一致）;
    // done/traceEvent 在父侧拼装出与 run() 等价的结果,usage/turns 上卷与 trace
    // 结构不回归。详见 reactLoop.md「子代理事件冒泡」章节
    if (eventEmitter) {
      const startedAt = performance.now();
      const traceEvents: AgentTraceEvent[] | undefined = callCtx.enableTracing ? [] : undefined;
      let done: NonNullable<ReactLoopStreamChunk['done']> | undefined;
      for await (const chunk of subAgent.stream(extractSubAgentUserInput(args), subOptions)) {
        if (chunk.subagentEvent) {
          // 更深层代理的事件（孙代理）:name/depth 已是深层信息,原样透传
          eventEmitter.onSubAgentEvent(chunk.subagentEvent);
        } else if (chunk.toolCall) {
          // 该子代理自身的 tool 开始执行
          eventEmitter.onSubAgentEvent({
            type: 'tool_call',
            name: toolName,
            depth: newDepth,
            toolName: chunk.toolCall.name,
            arguments: chunk.toolCall.arguments,
          });
        } else if (chunk.toolResult) {
          // 该子代理自身的 tool 执行完成（含错误串——tool 失败自然冒泡）
          eventEmitter.onSubAgentEvent({
            type: 'tool_result',
            name: toolName,
            depth: newDepth,
            toolName: chunk.toolResult.name,
            result: chunk.toolResult.result,
          });
        } else if (
          (typeof chunk.deltaContent === 'string' && chunk.deltaContent.length > 0) ||
          (typeof chunk.deltaReasoning === 'string' && chunk.deltaReasoning.length > 0)
        ) {
          // 该子代理自身 LLM 的增量
          eventEmitter.onSubAgentEvent({
            type: 'delta',
            name: toolName,
            depth: newDepth,
            deltaContent: chunk.deltaContent,
            deltaReasoning: chunk.deltaReasoning,
          });
        }
        if (chunk.traceEvent) {
          traceEvents!.push(chunk.traceEvent);
        }
        if (chunk.done) {
          done = chunk.done;
        }
      }
      this.emitAfterToolCallEvent(toolName, args, done?.content);
      const wrapped: SubAgentToolResult = {
        __subAgent: true,
        result: done?.content ?? '',
        usage: done?.usage,
        turns: done?.turns ?? 0,
      };
      if (traceEvents) {
        wrapped.trace = {
          agentName: '',
          traceId: subOptions.traceId,
          startedAt,
          durationMs: performance.now() - startedAt,
          turns: done?.turns ?? 0,
          usage: done?.usage,
          stopReason: done?.stopReason,
          content: done?.content,
          events: traceEvents,
        };
      }
      return wrapped;
    }

    // 非流式父循环：结果一次性返回,子循环跑非流式 run
    const result = await subAgent.run(extractSubAgentUserInput(args), subOptions);

    // 统一包装 SubAgentToolResult（无论 tracing 开关）:usage/turns 是子循环整树口径,
    // reactLoop 累加进父循环（父 run 台账 = 全部 llm_call 之和,详见 reactLoop.md）;
    // tracing 开启时附 trace,reactLoop 据此发出 subagent_call 事件
    this.emitAfterToolCallEvent(toolName, args, result.content);
    const wrapped: SubAgentToolResult = {
      __subAgent: true,
      result: result.content,
      usage: result.usage,
      turns: result.turns,
    };
    if (callCtx.enableTracing && result.trace) {
      wrapped.trace = result.trace;
    }
    return wrapped;
  }
}

/**
 * ctx 声明即校验的共享实现——executeToolCall（失败 `{ error }` 回传 LLM 重试语义）
 * 与 callTool（测试辅助，失败 throw 语义）共用，错误消息单一来源。
 *
 * tool 声明 `ctxTypeName` 时解析 ctx schema（复用 resolveToolSchema 同一实例；
 * schemaCache 传缓存时以 `ctx:` 前缀 key 与 input 缓存并存——resolver 以换名 ref
 * （inputTypeName = ctxTypeName）解析，zodPath#typeName 键天然区分）对合成 ctx
 * safeParse。校验只做门禁，不用校验后的 value 替换 ctx——schema strip 会丢掉
 * 框架注入字段（tasks/log/signal）。
 *
 * 失败返回错误消息（指明是 ctx 装配问题——前置条件不满足，修正入参无法解决），
 * 通过返回 undefined；未声明 ctxTypeName / 无 resolver / 解析为空均视为无校验。
 */
export async function validateToolCtx(
  deps: Pick<AgentDeps, 'resolveToolSchema'>,
  name: string,
  tool: ToolMetadata,
  ctx: AgentToolContext,
  schemaCache?: Map<string, ToolSchemaResolution | undefined>,
): Promise<string | undefined> {
  if (!tool.ctxTypeName || !deps.resolveToolSchema) return undefined;
  const ctxCacheKey = `ctx:${name}`;
  let ctxSchemaRes: ToolSchemaResolution | undefined;
  if (schemaCache?.has(ctxCacheKey)) {
    ctxSchemaRes = schemaCache.get(ctxCacheKey);
  } else {
    ctxSchemaRes = await deps.resolveToolSchema({ ...tool, inputTypeName: tool.ctxTypeName });
    schemaCache?.set(ctxCacheKey, ctxSchemaRes);
  }
  if (!ctxSchemaRes) return undefined;
  const ctxResult = ctxSchemaRes.validate(ctx as unknown as Record<string, unknown>);
  if (!ctxResult.ok) {
    return (
      `Tool "${name}" ctx 校验失败（工具执行前置条件不满足——这是 ctx 装配问题，` +
      `修正入参无法解决，请勿重试）: ${ctxResult.error}`
    );
  }
  return undefined;
}

/**
 * 单次 tool 调用的执行半段（getTool → 可选 input 校验 → loadToolModule → handler →
 * afterToolCall）——模块级独立函数
 *
 * 两个消费方：
 * - `Agent.executeTool` 常规 tool 分支（守卫 + 白名单 + sub-agent 分流留在类内——
 *   守卫覆盖 sub-agent 派发、白名单按声明集合校验；schemaCache 传实例缓存，
 *   保持"同一 tool 只解析一次"语义）
 * 校验失败返回 `{ error }` 对象（不抛错，回传 LLM 重试）；tool 未找到 / handler
 * 抛错原样上抛（reactLoop per-tool catch 回传 LLM）。agent:after-tool-call 订阅端
 * 自身抛错只留痕（审计故障不劫持执行语义）。
 */
export async function executeToolCall(
  deps: AgentDeps,
  name: string,
  args: Record<string, unknown>,
  ctx: AgentToolContext,
  schemaCache?: Map<string, ToolSchemaResolution | undefined>,
): Promise<unknown> {
  const tool = deps.getTool(name);
  if (!tool) {
    throw new Error(`Tool "${name}" not found`);
  }

  // 可选 input 校验（schemaCache 语义与 Agent.getToolSchema 一致——含 undefined
  // 结果，用 has 区分未解析 vs 解析为空；resolver 未提供时直接 undefined 不写缓存）
  let schemaRes: ToolSchemaResolution | undefined;
  if (!deps.resolveToolSchema) {
    schemaRes = undefined;
  } else if (schemaCache?.has(name)) {
    schemaRes = schemaCache.get(name);
  } else {
    schemaRes = await deps.resolveToolSchema(tool);
    schemaCache?.set(name, schemaRes);
  }
  let callArgs = args;
  if (schemaRes) {
    const result = schemaRes.validate(args);
    if (!result.ok) {
      // 校验失败：返回 { error } 对象，不调用 handler——错误回传 LLM 重试
      return { error: result.error };
    }
    callArgs = result.value ?? args;
  }

  // ctx 声明即校验（tool 声明 ctxTypeName 时）：失败返回 { error } 不调用 handler
  // （错误语义与消费方处理见 validateToolCtx 注释）
  const ctxError = await validateToolCtx(deps, name, tool, ctx, schemaCache);
  if (ctxError) return { error: ctxError };

  const mod = await deps.loadToolModule(tool.filePath, tool.functionName);
  const toolTimeoutMs = deps.config?.toolTimeoutMs;
  let result: unknown;
  if (toolTimeoutMs && toolTimeoutMs > 0) {
    // 超时竞速:到点抛 AgentToolTimeoutError,被 reactLoop per-tool catch 后回传 LLM。
    // 输了的 handler Promise 无从取消(同步持有的执行不中断),仅不再等待其结果
    result = await Promise.race([
      mod.handler(callArgs, ctx),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new AgentToolTimeoutError(name, toolTimeoutMs)),
          toolTimeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } else {
    result = await mod.handler(callArgs, ctx);
  }
  emitAfterToolCallEventOnDeps(deps, name, args, result);
  return result;
}

/**
 * agent:after-tool-call 事件（观察类留痕口径）
 *
 * tool / sub-agent 成功返回后发射（异常路径不发射）;载荷不含 tool 名（专属名
 * agent:after-tool-call:<toolName> 承载按 tool 路由——名字在事件名里）。载荷 result
 * 为观察面,改写不回写执行链路;订阅端抛错 console.error 留痕——不隔离会把成功的
 * tool 结果变成错误回传 LLM（审计故障劫持执行语义）。emitAppEvent 未接线时不发射。
 */
function emitAfterToolCallEventOnDeps(
  deps: AgentDeps,
  name: string,
  args: Record<string, unknown>,
  result: unknown,
): void {
  if (!deps.emitAppEvent) return;
  const { emitAppEvent } = deps;
  const payload: AfterToolCallEvent = { args, result, ctx: deps.ctx };
  void Promise.resolve()
    .then(() =>
      emitAppEvent(APP_EVENT.agentAfterToolCall, payload).then(() =>
        emitAppEvent(agentAfterToolCallEventName(name), payload),
      ),
    )
    .catch((hookErr) => {
      console.error(`[faapi] agent:after-tool-call subscriber error for tool "${name}":`, hookErr);
    });
}
