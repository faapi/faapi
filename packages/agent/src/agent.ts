import { readResource, subAgentToolName } from '@faapi/faapi';
import type {
  AgentCore,
  AgentMetadata,
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
  type SubAgentDeltaEmitter,
  type SubAgentToolResult,
} from './reactLoop';
import type { AgentTraceEvent } from './trace';

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
 * - **自定义 run**——agent handler 导出 `run` 函数时，sub-agent 走自定义逻辑
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
function extractSubAgentUserInput(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 1 && keys[0] === 'input' && typeof args.input === 'string') {
    return args.input;
  }
  return JSON.stringify(args);
}

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
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const missing = new Set(message.tool_calls.map((call) => call.id));
      for (let j = index + 1; j < messages.length && messages[j]!.role === 'tool'; j++) {
        missing.delete(messages[j]!.tool_call_id ?? '');
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
   * 单次 tool 执行的超时毫秒数（未设置 = 不限时）。超时抛 `AgentToolTimeoutError`,
   * 被 reactLoop 按既有 tool 错误路径回传 LLM（LLM 可决定重试或换路）——挂死的
   * tool handler（如无超时的内部 fetch）此前会让整个 run 永久挂起,且 run 的
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

/** 执行守卫钩子签名（ctx 为请求上下文透传——HTTP 完整 ctx / 任务窄对象 / 编程式 undefined） */
export type ToolCallGuardHook = (
  name: string,
  args: Record<string, unknown>,
  ctx: Partial<FaapiContext> | undefined,
) => void | ToolCallGuard;

/** 审计钩子签名（仅成功路径调用） */
export type AfterToolCallHook = (
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  ctx: Partial<FaapiContext> | undefined,
) => void;

/** 可见性过滤钩子签名 */
export type FilterToolsHook = (
  tools: LLMToolDefinition[],
  ctx: Partial<FaapiContext> | undefined,
) => LLMToolDefinition[];

/**
 * 本次调用的解析结果（[buildLoopConfig](#buildLoopConfig) 解析后经闭包传给 executeTool）
 *
 * - `agentName`——本次调用的有效 agent 名（执行白名单按它的声明集合校验）
 * - `enableTracing`——sub-agent 调用是否在 SubAgentToolResult 上附带 trace
 * - `provider` / `model`——解析出的 LLM 入口,sub-agent 递归继承（sub 元数据
 *   声明 `model` 时优先用自身的）
 */
interface AgentCallContext {
  agentName: string;
  enableTracing: boolean;
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
   * 请求上下文透传（authHooks ctx 传递链,见 [authHooks.md](./authHooks.md)）
   *
   * 类型为 Partial——框架自身零读取,纯透传给鉴权钩子与 tool handler 第二参数,
   * 完整性由调用方场景决定：
   * - HTTP 请求（@faapi/agent 工厂）传完整 ctx（完整可赋给 Partial）
   * - 任务内组装传窄对象（如鉴权硬闸需要的 `{ currentUserId }`,declare module
   *   增强字段免 cast 直传,完整 FaapiContext 任务侧无法构造）
   * - 编程式直调（测试/自定义启动器）不传,钩子收到 undefined
   *
   * sub-agent 递归经 subDeps 展开自动传导（同一调用内 ctx 不变）。
   */
  ctx?: Partial<FaapiContext>;
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
/** tool 执行超时（toolTimeoutMs）——被 reactLoop catch 后回传 LLM,不终止整个 run */
export class AgentToolTimeoutError extends AgentError {
  /** 超时的 tool 名 */
  readonly toolName: string;
  /** 配置的超时毫秒数 */
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = 'AgentToolTimeoutError';
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

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

    // 声明集合先于 tool 列表构建——派发名冲突 / agent 名非法在发起 LLM 请求前显式失败
    const { declaredTools, agentToolNames } = this.buildDeclaredTools(agentName);
    const tools = await this.buildToolDefinitions(agentName);

    // 解析 provider + model：options.provider（外部 provider）优先级最高,存在时跳过
    // options.model 的 llms key 解析（model 原样透传）；否则按字符串 key 规则解析
    const { provider, model } =
      options?.provider !== undefined
        ? this.resolveExternalProvider(options.provider, options?.model)
        : this.resolveModelKey(options?.model, meta);

    // 闭包捕获 enableTracing,通过 executeTool 传递给 executeSubAgent,使其决定是否附带 trace
    // enableTracing 优先级:options > deps.config > 默认 false（opt-in,零开销）
    const enableTracing = options?.enableTracing ?? this.deps.config?.enableTracing ?? false;

    // 本次调用的解析结果——executeTool / executeSubAgent 复用（路由按声明来源判定,
    // sub-agent 递归继承 provider/model）
    const callCtx: AgentCallContext = {
      agentName,
      enableTracing,
      provider,
      model,
      declaredTools,
      agentToolNames,
    };

    // systemPromptFile：每次 run 读文件内容作为 systemPrompt（不走缓存——dev 改
    // prompt 文件经 watcher 增量复制后立即生效，无需 reload）。读取经主包免传参
    // readResource（读取根 app 启动时绑定、隔离 worker 播种），越界/缺失显式抛
    // AgentError,不静默降级为空提示词
    const systemPrompt = await this.resolveSystemPrompt(agentName, meta);

    return {
      provider,
      systemPrompt,
      model,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      maxTurns: meta.maxTurns ?? this.deps.config?.maxTurns,
      maxHistoryTokens: this.deps.config?.maxHistoryTokens,
      tools,
      signal: options?.signal,
      messages: options?.messages,
      enableTracing,
      executeTool: async (name, args, deltaEmitter) =>
        this.executeTool(name, args, callCtx, deltaEmitter),
    };
  }

  /**
   * 解析 systemPrompt：声明 `systemPromptFile` 时读 resources 文件内容，否则用内联值
   *
   * 经主包免传参 `readResource` 读取（相对产物 resources 目录，越界/符号链接逃逸
   * 防护内建；读取根在 app 启动时绑定、隔离 worker 由 wrapper 播种，见主包
   * utils/readResource.md）。构建期已保证 systemPrompt 与 systemPromptFile 二选一
   * ——读取失败（未绑定 / 文件缺失 / 越界）抛 `AgentError`，不静默降级。
   */
  private async resolveSystemPrompt(agentName: string, meta: AgentCore): Promise<string> {
    if (!meta.systemPromptFile) return meta.systemPrompt as string;

    try {
      return await readResource(meta.systemPromptFile, 'utf-8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new AgentError(
        `Agent "${agentName}" systemPromptFile read failed: ${meta.systemPromptFile} (${reason}) — ` +
          'the file must exist under the runtime resources dir (src/resources/, copied into the dist by dev/build)',
      );
    }
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

    // 可见性过滤（authHooks）：无权 tool 不进 LLM 的 tools 清单（每次 run/stream 生效）
    const defs = Array.from(definitions.values());
    const filtered = this.deps.config?.filterTools?.(defs, this.deps.ctx);
    return filtered ?? defs;
  }

  /**
   * 解析 sub-agent 派发工具的 parameters（富 schema / 单字段 input 二选一）
   *
   * 富 schema 判定需要完整元数据的 `inputTypeName`（`AgentCore` 不含）——经
   * `getAgentEntry` 查询；未声明或 `resolveAgentInputSchema` 未接线时返回单字段
   * `input` schema（历史行为,完全向后兼容）。`inputDescription` 仍从 `AgentCore`
   * 读取（LLM 可见字段的既定来源,DB skill 同样可声明）。
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
    deltaEmitter?: SubAgentDeltaEmitter,
  ): Promise<unknown | SubAgentToolResult> {
    // 执行守卫（authHooks）：在 sub-agent 分流之前——一个钩子同时覆盖常规 tool
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
    // 路由按声明来源判定（declaredTools 与 agentToolNames 构建期保证不相交）——
    // 真工具 `agent-foo` 与 sub-agent `foo` 的派发名 `agent-foo` 互不误伤
    if (!callCtx.declaredTools.has(name) && !callCtx.agentToolNames.has(name)) {
      return {
        error: `Tool "${name}" is not declared by agent "${callCtx.agentName}" (add it to the agent's tools/agents declaration)`,
      };
    }

    // sub-agent 递归（映射取真实 agent 名;携带 callCtx,使其能继承 provider/model +
    // 决定是否附带 trace;deltaEmitter 由流式父循环下发——嵌套循环增量经此冒泡,
    // 见 reactLoop.md）
    const subName = callCtx.agentToolNames.get(name);
    if (subName !== undefined) {
      return await this.executeSubAgent(subName, args, callCtx, deltaEmitter);
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
    const toolTimeoutMs = this.deps.config?.toolTimeoutMs;
    let result: unknown;
    if (toolTimeoutMs && toolTimeoutMs > 0) {
      // 超时竞速:到点抛 AgentToolTimeoutError,被 reactLoop per-tool catch 后回传 LLM。
      // 输了的 handler Promise 无从取消(同步持有的执行不中断),仅不再等待其结果
      result = await Promise.race([
        mod.handler(callArgs, this.deps.ctx),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new AgentToolTimeoutError(name, toolTimeoutMs)),
            toolTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } else {
      result = await mod.handler(callArgs, this.deps.ctx);
    }
    try {
      this.deps.config?.afterToolCall?.(name, args, result, this.deps.ctx);
    } catch (hookErr) {
      // 审计钩子自身抛错只留痕——钩子在 return 前同步调用,不隔离会把成功的 tool
      // 结果变成错误回传 LLM(审计故障劫持执行语义,LLM 拿到审计报错还可能重试)
      console.error(`[faapi] afterToolCall hook error for tool "${name}":`, hookErr);
    }
    return result;
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
   *    resolver 未接线或未声明 `Input` 时跳过校验,行为与历史版本一致
   * 3. sub-agent handler 导出 `run` 时调自定义 `mod.run(args)`（无 trace、无结构化
   *    usage 可卷——直接返回业务结果,其 token 不进入父 run 台账）
   * 4. 无 `run` 时调 `subAgent.run(stringify(args), { agent, provider, model, enableTracing })`
   *    走默认 reactLoop——继承父调用的 provider,sub 元数据声明 `model` 时优先用自身的,
   *    未声明时沿用父 model
   *
   * **返回值统一包装为 [SubAgentToolResult](./reactLoop.md)**（无论 tracing 开关——
   * 用量上卷不依赖 tracing）：`usage` / `turns` 是子循环整树口径（sub-sub 已在子循环
   * 上卷）,reactLoop 识别后累加进父循环,父 run 的 usage 台账 = 全部 `llm_call` 之和。
   * `enableTracing=true` 时再附 `trace`（agentName 已被 `Agent.run` 填为 subName）,
   * reactLoop 据此发出 `subagent_call` 事件,嵌入 sub-trace（递归结构,业务方可还原
   * 完整调用树）。详见 reactLoop.md「usage 与 turns 的整树口径」。
   *
   * sub-agent 统一走默认 reactLoop（自定义 run 已移除,agent 声明式执行）。
   * user 消息：args 恰为单字段 `{ input: <string> }`（与显式入参 schema 形状一致）
   * 时直传字符串,其余形状 stringify 兜底（见 `extractSubAgentUserInput`）。
   */
  private async executeSubAgent(
    subName: string,
    rawArgs: Record<string, unknown>,
    callCtx: AgentCallContext,
    deltaEmitter?: SubAgentDeltaEmitter,
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

    // 派发工具名（subagentDelta 冒泡标识 + afterToolCall 审计名,即 LLM 看到的名字）
    const toolName = subAgentToolName(subName);

    // 构造子 agent（复用父 deps——providers/llms/访问器共享,无 per-agent 名绑定）
    const subAgent = new Agent(this.deps, newDepth);

    // 继承父调用的 provider；sub 元数据声明 model 时优先用自身的,
    // 未声明时沿用父 model。单字段 { input } 直传字符串（与显式入参 schema 形状一致）,
    // 其余形状 stringify 兜底;传递 enableTracing 让 sub-agent 采集 trace
    const subMeta = this.deps.getAgent(subName);
    const subOptions: AgentRunOptions = {
      agent: subName,
      provider: callCtx.provider,
      model: subMeta?.model ?? callCtx.model,
      enableTracing: callCtx.enableTracing,
    };

    // 流式父循环（deltaEmitter 存在）：子循环也跑流式,嵌套循环的 deltaContent /
    // deltaReasoning 经 emitter 实时冒泡为父流的 subagentDelta chunk（reasoning 仅
    // 透出不进历史,与 thinking 剥离纪律一致）;done/traceEvent 在父侧拼装出与
    // run() 等价的结果,usage/turns 上卷与 trace 结构不回归。详见 reactLoop.md
    // 「子代理 delta 冒泡」章节
    if (deltaEmitter) {
      const startedAt = performance.now();
      const traceEvents: AgentTraceEvent[] | undefined = callCtx.enableTracing ? [] : undefined;
      let done: NonNullable<ReactLoopStreamChunk['done']> | undefined;
      for await (const chunk of subAgent.stream(extractSubAgentUserInput(args), subOptions)) {
        if (chunk.subagentDelta) {
          // 更深层代理的冒泡（孙代理）:name/depth 已是深层信息,原样透传
          deltaEmitter.onSubAgentDelta(chunk.subagentDelta);
        } else if (
          (typeof chunk.deltaContent === 'string' && chunk.deltaContent.length > 0) ||
          (typeof chunk.deltaReasoning === 'string' && chunk.deltaReasoning.length > 0)
        ) {
          // 该子代理自身 LLM 的增量
          deltaEmitter.onSubAgentDelta({
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
      this.deps.config?.afterToolCall?.(toolName, args, done?.content, this.deps.ctx);
      const wrapped: SubAgentToolResult = {
        __subAgent: true,
        result: done?.content ?? '',
        usage: done?.usage,
        turns: done?.turns ?? 0,
      };
      if (traceEvents) {
        wrapped.trace = {
          agentName: '',
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
    this.deps.config?.afterToolCall?.(toolName, args, result.content, this.deps.ctx);
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
