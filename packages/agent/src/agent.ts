import type {
  AgentCore,
  AgentMetadata,
  AgentModule,
  AgentToolDescriptor,
  FaapiContext,
  LlmConfig,
  ToolMetadata,
  ToolModule,
} from '@faapi/faapi';
import type { AgentRunOptions } from './agentHandle';
import { createProvider } from './provider';
import type { LLMMessage, LLMProvider, LLMToolDefinition } from './provider';
import {
  reactLoop,
  reactLoopStream,
  type ReactLoopConfig,
  type ReactLoopResult,
  type ReactLoopStreamChunk,
} from './reactLoop';
import type { TracingToolResult } from './trace';

/**
 * Agent 类——按 `agent.name` 查找元数据、组装 tool 列表、提供 `run` / `stream` / `asTool`
 *
 * 把 [reactLoop](./reactLoop.md) 与 faapi 核心的 agent/tool 注册表粘合起来：
 * - **组装 tool 列表**——合并 `resolveAgentTools`（agent 显式声明的 `tools`）+ sub-agent
 * - **执行 tool**——`reactLoop` 调 `executeTool(name, args)` 时，Agent 路由：
 *   - 常规 tool → `loadToolModule` 加载 handler + 可选 input 校验 → 调用
 *   - `agent.` 前缀 → 递归构造 sub-agent 调用（含 `maxAgentDepth` 防护）
 * - **递归防护**——`maxAgentDepth` 限制 agent 调用 agent 的深度
 * - **自定义 run**——agent handler 导出 `run` 函数时，sub-agent 走自定义逻辑
 *
 * 详见 [agent.md](./agent.md)。
 */

/** 默认最大 agent 递归深度（根 agent depth=1，sub-agent 递增） */
const DEFAULT_MAX_AGENT_DEPTH = 3;

/** 合法消息 role（与 LLMMessage 的 role 联合一致，运行时校验反序列化历史用） */
const VALID_MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

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
  messages.forEach((message, index) => {
    if (!VALID_MESSAGE_ROLES.has(message.role)) {
      throw new AgentError(
        `Invalid resume history at messages[${index}]: unknown role "${String(message.role)}"`,
      );
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const missing = new Set(message.toolCalls.map((call) => call.id));
      for (let j = index + 1; j < messages.length && messages[j]!.role === 'tool'; j++) {
        missing.delete(messages[j]!.toolCallId ?? '');
      }
      if (missing.size > 0) {
        throw new AgentError(
          `Invalid resume history at messages[${index}]: assistant tool call(s) [${Array.from(missing).join(', ')}] have no matching tool result (history truncated mid-turn — persist the full turn group from AgentAbortError.messages / ReactLoopError.messages)`,
        );
      }
    }
  });
}

/**
 * 全局 agent 配置覆盖
 *
 * 来自 faapi.config.ts 的 `agent` 块，提供全局默认值。
 * agent 自身 `config.maxTurns` / `config.model` 优先于全局配置。
 */
export interface AgentRuntimeConfig {
  /** 默认最大对话轮数（agent 自身 maxTurns 优先） */
  maxTurns?: number;
  /** agent 调用 agent 的最大递归深度（默认 3） */
  maxAgentDepth?: number;
  /** 发送给 LLM 的历史 token 预算（近似估算,未设置 = 不裁剪）——透传 reactLoop,见 reactLoop.md 历史裁剪章节 */
  maxHistoryTokens?: number;
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
   * 执行守卫（authHooks,见 [authHooks.md](./authHooks.md)）
   *
   * `executeTool` 最开头调用（`agent.` 分流之前）——同时覆盖常规 tool 与
   * sub-agent 递归。三种返回：`void` 放行；`{ error }` 拒绝（不执行 handler,
   * error 回传 LLM）；`{ args }` 改写后放行（多租户场景强制注入可信值,
   * 不信 LLM 传入的标识参数）。
   */
  beforeToolCall?: ToolCallGuardHook;
  /**
   * 审计钩子（authHooks）：tool / sub-agent 成功返回后调用,返回值忽略。
   * 异常路径不调用。
   */
  afterToolCall?: AfterToolCallHook;
  /**
   * 可见性过滤（authHooks）：`buildToolDefinitions` 组装完 LLM 可见 tools 后
   * 调用,返回过滤后的数组。每次 `run` / `stream` 生效,含 agent-as-tool 项。
   */
  filterTools?: FilterToolsHook;
}

/**
 * beforeToolCall 的返回守卫
 *
 * - `{ error }`：拒绝执行,error 字符串回传 LLM
 * - `{ args }`：以改写后的参数继续执行
 */
export type ToolCallGuard = { error: string } | { args: Record<string, unknown> };

/** 执行守卫钩子签名（ctx 为请求上下文,编程式直调可能为 undefined） */
export type ToolCallGuardHook = (
  name: string,
  args: Record<string, unknown>,
  ctx: FaapiContext | undefined,
) => void | ToolCallGuard;

/** 审计钩子签名（仅成功路径调用） */
export type AfterToolCallHook = (
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  ctx: FaapiContext | undefined,
) => void;

/** 可见性过滤钩子签名 */
export type FilterToolsHook = (
  tools: LLMToolDefinition[],
  ctx: FaapiContext | undefined,
) => LLMToolDefinition[];

/**
 * 本次调用的解析结果（[buildLoopConfig](#buildLoopConfig) 解析后经闭包传给 executeTool）
 *
 * - `agentName`——本次调用的有效 agent 名（执行白名单按它的声明集合校验）
 * - `enableTracing`——sub-agent 调用是否包装 TracingToolResult
 * - `provider` / `model`——解析出的 LLM 入口,sub-agent 递归继承（sub 元数据
 *   声明 `model` 时优先用自身的）
 */
interface AgentCallContext {
  agentName: string;
  enableTracing: boolean;
  provider: LLMProvider;
  model: string | undefined;
}

/**
 * tool schema 解析结果
 *
 * 由 Phase 3.5 的注入器实现，提供 JSON Schema（给 LLM）和校验函数（给执行前校验）。
 * - `jsonSchema` —— 发给 LLM 作为 tool 参数描述
 * - `validate` —— 执行前校验 LLM 返回的参数，失败时返回 `{ error }` 回传 LLM 重试
 */
export interface ToolSchemaResolution {
  /** tool 参数的 JSON Schema（发给 LLM） */
  jsonSchema: Record<string, unknown>;
  /** 执行前校验函数（成功返回 coerce 后的 value，失败返回 error） */
  validate: (
    input: Record<string, unknown>,
  ) => { ok: true; value: Record<string, unknown> } | { ok: false; error: string };
}

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
   * 请求上下文（authHooks ctx 传递链,见 [authHooks.md](./authHooks.md)）
   *
   * 由 @faapi/agent 工厂捕获（AgentHandleFactory 签名本就接收 ctx）。
   * 编程式直调（测试/自定义启动器）不传,钩子收到 undefined。
   * sub-agent 递归经 subDeps 展开自动传导（同一 HTTP 请求内 ctx 不变）。
   */
  ctx?: FaapiContext;
  /** 查 agent LLM 可见元数据（对应 agentRegistry.getAgent,返回 AgentCore） */
  getAgent: (name: string) => AgentCore | undefined;
  /** 查 agent 完整元数据（对应 agentRegistry.getAgentEntry,返回 AgentMetadata 含 filePath/hasRun） */
  getAgentEntry: (name: string) => AgentMetadata | undefined;
  /** 查 tool 元数据（对应 toolRegistry.getTool） */
  getTool: (name: string) => ToolMetadata | undefined;
  /** 解析 agent 可用常规 tool（对应 agentRegistry.resolveAgentTools） */
  resolveAgentTools: (name: string) => ToolMetadata[];
  /** 解析 agent 可调用 sub-agent 列表（对应 agentRegistry.resolveSubAgents,返回 AgentCore[]） */
  resolveSubAgents: (name: string) => AgentCore[];
  /** 动态 import tool handler（对应 loadToolModule） */
  loadToolModule: (filePath: string, functionName: string) => Promise<ToolModule>;
  /** 动态 import agent handler（对应 loadAgentModule,仅 hasRun 参数,无 hasConfig） */
  loadAgentModule: (filePath: string, hasRun: boolean) => Promise<AgentModule>;
  /** tool input 的 schema 解析（Phase 3.5 实现，可选） */
  resolveToolSchema?: (tool: ToolMetadata) => Promise<ToolSchemaResolution | undefined>;
}

/**
 * Agent 系统级错误
 *
 * agent 未注册等不可恢复错误时抛出（调用方负责捕获）。
 * sub-agent 递归超限用 {@link AgentRecursionError}。
 */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

/**
 * sub-agent 递归超 `maxAgentDepth` 时抛出
 *
 * 被 [reactLoop](./reactLoop.md) catch 后错误消息回传 LLM，LLM 可据此调整策略。
 */
export class AgentRecursionError extends AgentError {
  /** 配置的 maxAgentDepth 值 */
  readonly maxDepth: number;
  /** 当前递归深度（超出 maxDepth） */
  readonly currentDepth: number;

  constructor(maxDepth: number, currentDepth: number) {
    super(
      `Agent recursion depth exceeded: current depth ${currentDepth} > maxAgentDepth ${maxDepth}`,
    );
    this.name = 'AgentRecursionError';
    this.maxDepth = maxDepth;
    this.currentDepth = currentDepth;
  }
}

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
    const config = await this.buildLoopConfig(input, options);
    const result = await reactLoop(input, config);
    // reactLoop 不知 agent 名,在此填充顶层 trace.agentName（sub-agent 调本方法时也走此路径）
    if (result.trace) {
      result.trace.agentName = options?.agent ?? '';
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
    const config = await this.buildLoopConfig(input, options);
    yield* reactLoopStream(input, config);
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
      name: `agent.${meta.name}`,
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
   * 组装 ReactLoopConfig
   *
   * 1. 解析有效 agent 名：`options.agent`（必须显式传——无默认 agent,不传抛 AgentError）
   * 2. 查 agent 元数据（未注册抛 AgentError）——用 `getAgent` 拿 AgentCore
   *    (LLM-facing 字段:systemPrompt / model / maxTurns)
   * 3. buildToolDefinitions 组装 tool 列表（用有效 agent 名查 tools / sub-agents）
   * 4. config 字段优先级（高 → 低）：`options` > agent 元数据 > 全局 AgentRuntimeConfig
   *
   * `options.provider`（外部 provider）存在时由 {@link resolveExternalProvider} 物化,
   * 优先级最高——`options.model` 变为原始 model 名原样透传（不解析 llms key）。
   * 否则 `options.model` 是字符串 key,由 {@link resolveModelKey} 解析为 provider + model
   * （支持 llms key 精确匹配 / `provider/model` 一体化 / 纯 model 名模糊匹配；
   * 未传 `options.model` 时用 agent 元数据 `config.model` 作为缺省 key）。
   * 详见 [agentHandle.md](./agentHandle.md) 的「`options.model` 字符串 key 解析规则」。
   *
   * **输入守卫**（续跑入口,见 [reactLoop.md](./reactLoop.md) 中断恢复章节）：
   * `input` 与 `options.messages` 都为空时抛 `AgentError`（不发送空请求）；
   * `options.messages` 提供时先经 `validateResumeHistory` 结构校验,非法抛
   * `AgentError`,不发起 LLM 请求。
   */
  private async buildLoopConfig(
    input: string | undefined,
    options?: AgentRunOptions,
  ): Promise<ReactLoopConfig> {
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

    const tools = await this.buildToolDefinitions(agentName);

    // 解析 provider + model：options.provider（外部 provider）优先级最高,存在时跳过
    // options.model 的 llms key 解析（model 原样透传）；否则按字符串 key 规则解析
    const { provider, model } =
      options?.provider !== undefined
        ? this.resolveExternalProvider(options.provider, options?.model)
        : this.resolveModelKey(options?.model, meta);

    // enableTracing 优先级:options > deps.config > 默认 false（opt-in,零开销）
    // 闭包捕获 enableTracing,通过 executeTool 传递给 executeSubAgent,使其能包装 TracingToolResult
    const enableTracing = options?.enableTracing ?? this.deps.config?.enableTracing ?? false;

    // 本次调用的解析结果——executeTool / executeSubAgent 复用（白名单校验用 agentName,
    // sub-agent 递归继承 provider/model）
    const callCtx = { agentName, enableTracing, provider, model };

    return {
      provider,
      systemPrompt: meta.systemPrompt,
      model,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      maxTurns: meta.maxTurns ?? this.deps.config?.maxTurns,
      tools,
      signal: options?.signal,
      messages: options?.messages,
      enableTracing,
      executeTool: async (name, args) => this.executeTool(name, args, callCtx),
    };
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
   * 解析 `options.model` 字符串 key → provider + model
   *
   * 规则见 [agentHandle.md](./agentHandle.md) 的「`options.model` 字符串 key 解析规则」。
   * 无默认 provider——`key` 未传时用 agent 元数据 `config.model` 作为缺省 key；
   * 两者皆无抛 `AgentError`（要求调用方传 `options.model` 或 `options.provider`）。
   * 1. 精确匹配 `deps.providers` 的 key → 该 provider + 其 `models` 第一个 key
   *    （该 provider 未声明 `models` 时回落 `meta.model`）
   * 2. 含 `/` → `provider/model` 形式,`deps.providers.get(provider)` + 该 model
   *    （要求该 model 在 `deps.llms[provider].models` 里）
   * 3. 不含 `/` 且非 provider key → 在所有 provider 的 `models` 里按 model 名查找
   *    - 唯一 → 该 provider + 该 model
   *    - 多个 → 抛 `AgentError`（要求用 `provider/model` 消歧）
   *    - 无 → 抛 `AgentError`
   *
   * @throws {AgentError} key 与 `meta.model` 均缺省；key 解析失败（provider/model
   *   不存在或歧义）
   */
  private resolveModelKey(
    key: string | undefined,
    meta: AgentCore,
  ): { provider: LLMProvider; model: string | undefined } {
    // 无默认 provider——未传 options.model 时用 agent 元数据 model 作为缺省 key
    const effectiveKey = key ?? meta.model;
    if (effectiveKey === undefined) {
      throw new AgentError(
        'No LLM provider resolved: pass options.model (a provider key / "provider/model" / model name from config.agent.llms), options.provider (external provider), or declare model in the agent config',
      );
    }

    // 规则 1：精确匹配 providers key（如 'openai'）
    const byProviderKey = this.deps.providers.get(effectiveKey);
    if (byProviderKey) {
      const llmConfig = this.deps.llms[effectiveKey];
      const firstModel = llmConfig ? Object.keys(llmConfig.models)[0] : undefined;
      return { provider: byProviderKey, model: firstModel ?? meta.model };
    }

    // 规则 2：含 '/' → provider/model 形式（如 'openai/gpt-4o'）
    if (effectiveKey.includes('/')) {
      const slashIdx = effectiveKey.indexOf('/');
      const providerName = effectiveKey.slice(0, slashIdx);
      const modelName = effectiveKey.slice(slashIdx + 1);
      const provider = this.deps.providers.get(providerName);
      if (!provider) {
        throw new AgentError(
          `Unknown provider "${providerName}" in model key "${effectiveKey}". Declare it in config.agent.llms, or pass options.provider to use an external provider.`,
        );
      }
      const llmConfig = this.deps.llms[providerName];
      if (!llmConfig || !llmConfig.models[modelName]) {
        throw new AgentError(
          `Model "${modelName}" not found in provider "${providerName}". Declare it in config.agent.llms.${providerName}.models.`,
        );
      }
      return { provider, model: modelName };
    }

    // 规则 3：纯 model 名模糊匹配（如 'gpt-4o'）
    const matches: { provider: LLMProvider; providerName: string }[] = [];
    for (const [providerName, provider] of this.deps.providers) {
      const llmConfig = this.deps.llms[providerName];
      if (llmConfig && llmConfig.models[effectiveKey]) {
        matches.push({ provider, providerName });
      }
    }
    if (matches.length === 1) {
      return { provider: matches[0]!.provider, model: effectiveKey };
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
   * 组装 LLM 可见 tool 列表
   *
   * 合并两个来源（按 `name` 去重，先入者保留）：
   * 1. **resolveAgentTools** —— agent 显式声明的 `tools` 引用
   * 2. **sub-agent** —— `resolveSubAgents` 每个包装为 `agent.<name>`
   *
   * 每个常规 tool 的 `input`：
   * - `resolveToolSchema` 提供 → 用其 `jsonSchema`
   * - 未提供 / tool 无 `inputTypeName` → 自由 schema `{ type: 'object' }`
   *
   * sub-agent 的 `input` 始终为 `{ type: 'object' }`（agent 参数开放）。
   */
  private async buildToolDefinitions(agentName: string): Promise<LLMToolDefinition[]> {
    const definitions = new Map<string, LLMToolDefinition>();

    // 1. resolveAgentTools（agent 显式声明的 tools 引用）
    for (const tool of this.deps.resolveAgentTools(agentName)) {
      if (definitions.has(tool.name)) continue;
      const schemaRes = await this.getToolSchema(tool);
      definitions.set(tool.name, {
        name: tool.name,
        description: tool.description,
        input: schemaRes?.jsonSchema ?? { type: 'object' },
      });
    }

    // 2. sub-agent（包装为 agent.<name>）
    for (const subAgent of this.deps.resolveSubAgents(agentName)) {
      const name = `agent.${subAgent.name}`;
      if (definitions.has(name)) continue;
      definitions.set(name, {
        name,
        description: subAgent.description,
        input: { type: 'object' },
      });
    }

    // 可见性过滤（authHooks）：无权 tool 不进 LLM 的 tools 清单（每次 run/stream 生效）
    const defs = Array.from(definitions.values());
    const filtered = this.deps.config?.filterTools?.(defs, this.deps.ctx);
    return filtered ?? defs;
  }

  /**
   * tool 执行路由（由 reactLoop 调用）
   *
   * - `agent.` 前缀 → {@link executeSubAgent} 递归（含 enableTracing + TracingToolResult 包装）
   * - 常规 tool → `loadToolModule` 加载 handler + 可选 input 校验 → 调用
   *
   * `callCtx` 由 [buildLoopConfig](#buildLoopConfig) 闭包捕获传入——本次调用的有效
   * agent 名（白名单校验）、enableTracing（sub-agent tracing 包装）与解析出的
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
  ): Promise<unknown | TracingToolResult> {
    // 执行守卫（authHooks）：在 agent. 分流之前——一个钩子同时覆盖常规 tool
    // 与 sub-agent 递归。拒绝时不执行目标,守卫的 error 回传 LLM;
    // 改写时以守卫返回的 args 继续（多租户场景强制注入可信值）
    const name = rawName;
    let args = rawArgs;
    const guard = this.deps.config?.beforeToolCall?.(name, args, this.deps.ctx);
    if (guard) {
      if ('error' in guard) return { error: guard.error };
      if ('args' in guard) args = guard.args;
    }

    // 执行白名单：只允许 agent 声明的 tools / sub-agents。`tools`/`agents` 声明不只是
    // LLM 可见性过滤——LLM 幻觉或被提示注入时可能请求未声明的任意已注册 tool
    // （如管理类 tool）,执行前按声明集合强制校验,未声明一律拒绝（错误回传 LLM,
    // 与参数校验失败语义一致）。sub-agent 递归时每个 depth 层按自己的声明集合校验。
    const declared = new Set<string>();
    for (const tool of this.deps.resolveAgentTools(callCtx.agentName)) {
      declared.add(tool.name);
    }
    for (const sub of this.deps.resolveSubAgents(callCtx.agentName)) {
      declared.add(`agent.${sub.name}`);
    }
    if (!declared.has(name)) {
      return {
        error: `Tool "${name}" is not declared by agent "${callCtx.agentName}" (add it to the agent's tools/agents declaration)`,
      };
    }

    // sub-agent 递归（携带 callCtx,使其能继承 provider/model + 包装 TracingToolResult）
    if (name.startsWith('agent.')) {
      return await this.executeSubAgent(name.slice(6), args, callCtx);
    }

    // 常规 tool
    const tool = this.deps.getTool(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }

    // 可选 input 校验
    const schemaRes = await this.getToolSchema(tool);
    let callArgs = args;
    if (schemaRes) {
      const result = schemaRes.validate(args);
      if (!result.ok) {
        // 校验失败：返回 { error } 对象，不调用 handler——错误回传 LLM 重试
        return { error: result.error };
      }
      callArgs = result.value ?? args;
    }

    const mod = await this.deps.loadToolModule(tool.filePath, tool.functionName);
    const result = await mod.handler(callArgs, this.deps.ctx);
    this.deps.config?.afterToolCall?.(name, args, result, this.deps.ctx);
    return result;
  }

  /**
   * sub-agent 递归执行
   *
   * 1. `maxAgentDepth` 防护——超限抛 {@link AgentRecursionError}
   * 2. sub-agent handler 导出 `run` 时调自定义 `mod.run(args)`（无 trace,与常规 tool 一致）
   * 3. 无 `run` 时调 `subAgent.run(stringify(args), { agent, provider, model, enableTracing })`
   *    走默认 reactLoop——继承父调用的 provider,sub 元数据声明 `model` 时优先用自身的,
   *    未声明时沿用父 model
   *
   * **tracing 路径**：`enableTracing=true` 时,subAgent.run 返回的 `result.trace`（agentName
   * 已被 `Agent.run` 填为 subName）被包装为 [TracingToolResult](./trace.md) 返回给 reactLoop。
   * reactLoop 通过 `isTracingToolResult` 识别后发出 `subagent_call` 事件,嵌入 sub-trace
   * （递归结构,业务方可还原完整调用树）。`enableTracing=false` 时返回 `result.content`
   * （unknown,与常规 tool 一致,零开销）。
   *
   * **自定义 run 无 trace**：业务方导出 `run` 函数时直接返回业务结果,无法采集 sub-agent
   * 内部明细——需 trace 时应让 sub-agent 走默认 reactLoop（不导出 `run`）。
   *
   * 自定义 run 接收原始 args 对象；默认 reactLoop 接收 stringify 后的 args
   * 作为 user 消息（agent-as-tool input 为开放式 JSON）。
   *
   * 加载 handler.js 用 `getAgentEntry`(返回 AgentMetadata,含 filePath/hasRun),
   * 而非 `getAgent`(返回 AgentCore,无代码加载细节)。DB skill 无文件,
   * `getAgentEntry` 返回 `undefined`,走默认 reactLoop。
   */
  private async executeSubAgent(
    subName: string,
    args: Record<string, unknown>,
    callCtx: AgentCallContext,
  ): Promise<unknown | TracingToolResult> {
    const newDepth = this.depth + 1;
    const maxDepth = this.deps.config?.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH;
    if (newDepth > maxDepth) {
      throw new AgentRecursionError(maxDepth, newDepth);
    }

    // 构造子 agent（复用父 deps——providers/llms/访问器共享,无 per-agent 名绑定）
    const subAgent = new Agent(this.deps, newDepth);

    // 自定义 run：sub-agent handler 导出 run 函数时走自定义逻辑（无 trace）
    // 用 getAgentEntry 拿 AgentMetadata(含 filePath/hasRun),DB skill 无文件走默认 reactLoop
    const entry = this.deps.getAgentEntry(subName);
    if (entry?.hasRun) {
      const mod = await this.deps.loadAgentModule(entry.filePath, entry.hasRun);
      if (mod.run) {
        const result = await mod.run(args, this.deps.ctx);
        this.deps.config?.afterToolCall?.(`agent.${subName}`, args, result, this.deps.ctx);
        return result;
      }
    }

    // 默认 reactLoop：继承父调用的 provider；sub 元数据声明 model 时优先用自身的,
    // 未声明时沿用父 model。stringify args 作为 user 消息（agent-as-tool input 为开放式 JSON）,
    // 传递 enableTracing 让 sub-agent 采集 trace
    const subMeta = this.deps.getAgent(subName);
    const result = await subAgent.run(typeof args === 'string' ? args : JSON.stringify(args), {
      agent: subName,
      provider: callCtx.provider,
      model: subMeta?.model ?? callCtx.model,
      enableTracing: callCtx.enableTracing,
    });

    // enableTracing=true:包装 TracingToolResult,reactLoop 据此发出 subagent_call 事件
    // enableTracing=false:直接返回 content（unknown,与常规 tool 一致,零开销）
    this.deps.config?.afterToolCall?.(`agent.${subName}`, args, result.content, this.deps.ctx);
    if (callCtx.enableTracing && result.trace) {
      return {
        __trace: true,
        result: result.content,
        trace: result.trace,
      } satisfies TracingToolResult;
    }
    return result.content;
  }
}
