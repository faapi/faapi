import { AgentAbortError } from './provider';
import { APP_EVENT, agentHistoryOverBudgetEventName, agentInputEventName } from '@faapi/faapi';
import type { AgentToolContext, AppEventEmitter } from '@faapi/faapi';
import { AgentError } from './agentErrors';
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMStopReason,
  LLMToolCall,
  LLMToolDefinition,
  LLMUsage,
} from './provider';
import {
  isTracingToolResult,
  type AgentTrace,
  type AgentTraceEvent,
  type TracingToolResult,
} from './trace';

/**
 * ReAct（Reasoning + Acting）循环引擎
 *
 * 反复调 LLM、执行 tool、把结果回传 LLM，直到 LLM 给出最终回答或达到 `maxTurns` 上限。
 *
 * 详见 [reactLoop.md](./reactLoop.md)。
 */

/**
 * Tool 执行函数
 *
 * 由 [Agent 类](./agent.md)提供——reactLoop 不关心 tool 如何被找到和执行。
 * Agent 类的 `executeTool` 实现：
 * - 常规 tool → `loadToolModule` 加载 handler 并调用
 * - agent-as-tool（`agent-` 前缀派发名）→ 递归调子 agent 的 reactLoop（`maxAgentDepth` 防护由 Agent 类在 `executeTool` 内实现），
 *   返回 [SubAgentToolResult](#subagenttoolresult)（携带子循环整树 `usage` / `turns` 供父循环上卷）
 *
 * 返回值可以是任意类型——非 string 会被 JSON.stringify 后回传 LLM。
 *
 * sub-agent 调用时,`SubAgentToolResult.trace` 存在（`enableTracing=true`）时
 * reactLoop 发出 `subagent_call` 事件（嵌套递归 trace）；旧 `TracingToolResult`
 * （`__trace` 标记,无用量字段）仍兼容识别,但不上卷用量。
 */
/**
 * 嵌套子代理循环的增量（流式父循环冒泡透出）
 *
 * 仅流式路径产生；`depth` 与 `maxAgentDepth` 口径一致（根循环 = 1,首次嵌套的
 * 子代理 = 2）。`deltaContent` / `deltaReasoning` 至少存在其一。
 */
export interface SubAgentDelta {
  /** 发起调用的派发 tool 名（agent-<name>） */
  name: string;
  /** 该子代理循环的递归深度（根 = 1） */
  depth: number;
  deltaContent?: string;
  deltaReasoning?: string;
}

/**
 * delta 冒泡出口：executeTool 执行 sub-agent 时回调透出嵌套循环增量
 *
 * 仅流式父循环传入（`reactLoopStream` 的 tool 执行段构造 emitter 经第三参下发）；
 * 非流式 `reactLoop` 不传（结果一次性返回,无冒泡需求）。
 */
export interface SubAgentDeltaEmitter {
  onSubAgentDelta(delta: SubAgentDelta): void;
}

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  deltaEmitter?: SubAgentDeltaEmitter,
) => Promise<unknown | SubAgentToolResult>;

/**
 * sub-agent tool 的结构化返回值——reactLoop 据此上卷子循环用量、剥壳回传、发 subagent_call 事件
 *
 * [Agent.executeSubAgent](./agent.md) 在 sub-agent 走默认 reactLoop 时统一构造
 * （无论 tracing 开关——用量上卷不依赖 tracing）。reactLoop 通过
 * `isSubAgentToolResult` 识别后：`usage` / `turns` 累加进父循环（整树口径,
 * 详见 reactLoop.md「usage 与 turns 的整树口径」）,随后剥壳取 `result` 作为
 * tool 消息回传 LLM;`trace` 存在时再发 `subagent_call` 事件。
 *
 * `__subAgent` 是标记字段,避免与普通对象返回值冲突。
 */
export interface SubAgentToolResult {
  /** 标记字段（避免与普通对象返回值冲突） */
  __subAgent: true;
  /** 子代理返回的业务结果（stringifyResult 后作为 tool 消息内容回传 LLM） */
  result: unknown;
  /** 子循环整树 token 用量（provider 未返回结构化用量时缺省 = 计 0） */
  usage?: LLMUsage;
  /** 子循环整树轮数（缺省 = 计 0） */
  turns?: number;
  /** 子循环 trace（`enableTracing=true` 时携带,reactLoop 发 subagent_call 事件并嵌入） */
  trace?: AgentTrace;
}

/**
 * 类型守卫：判断 ToolExecutor 返回值是否为 SubAgentToolResult
 */
export function isSubAgentToolResult(value: unknown): value is SubAgentToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __subAgent?: unknown }).__subAgent === true
  );
}

/**
 * reactLoop 配置
 *
 * 由 [Agent 类](./agent.md)组装并传入。
 */
export interface ReactLoopConfig {
  /** LLM provider 实例（由 [createProvider](./provider.md) 创建） */
  provider: LLMProvider;
  /** 系统提示词（来自 agent metadata 的 `systemPrompt`） */
  systemPrompt?: string;
  /** 可用 tool 列表（由 `resolveAgentTools` + `resolveSubAgents().map(asTool)` 组装） */
  tools?: LLMToolDefinition[];
  /** tool 执行函数（由 Agent 类提供，路由到常规 tool 或子 agent） */
  executeTool: ToolExecutor;
  /** 最大对话轮数（默认 10，来自 [AgentConfig](../../faapi/src/configs/configTypes.md).maxTurns） */
  maxTurns?: number;
  /** 覆盖 LLM 模型名（来自 agent metadata 的 `model`） */
  model?: string;
  /** 采样温度 */
  temperature?: number;
  /** 最大生成 token 数 */
  maxTokens?: number;
  /**
   * 取消信号（透传到每轮 LLM 请求）
   *
   * 循环每轮开始前预检查：已取消时抛 `AgentAbortError`（不再发起 LLM 调用）；
   * 执行中取消由 provider 的请求中断传播。tool 执行不被取消（业务自决）。
   */
  signal?: AbortSignal;
  /**
   * 历史超限事件触发阈值（近似估算：字符数 / 2；未设置 = 不估算不发射）
   *
   * 框架不内置任何裁剪/压缩——每轮估算超过阈值时发射 `agent:history-over-budget`
   * 事件（见 reactLoop.md 同名章节），长度控制完全由订阅端承接（`replace` 整体
   * 替换循环历史）；未订阅事件时超限历史原样发送（provider 可能 400——显式能力
   * 边界，非降级）。
   */
  maxHistoryTokens?: number;
  /**
   * 初始对话历史（续跑 / 多轮对话）
   *
   * 提供时以其为基础（历史应含 system）：历史无 `system` 消息且配置了
   * `systemPrompt` 时自动在最前插入（agent 人格不因续跑丢失）；`input` 非空时
   * 追加为新的 `user` 消息（多轮对话），为空时纯续跑。历史经 `Agent` 层结构校验
   * （assistant.tool_calls 与 tool 结果按 tool_call_id 配对完整）。
   * 续跑源见 [reactLoop.md](./reactLoop.md) 中断恢复章节。
   */
  messages?: LLMMessage[];
  /**
   * 启用 tracing（默认 false——opt-in,不开启零开销）。开启时填充
   * `ReactLoopResult.trace` / `ReactLoopStreamChunk.traceEvent`,详见 [trace.md](./trace.md)。
   *
   * 与 `AgentRuntimeConfig.enableTracing` / `AgentRunOptions.enableTracing` 同语义：
   * 优先级 options > 全局 config > 默认 false。
   */
  enableTracing?: boolean;
  /**
   * app 事件上下文（可选——`buildLoopConfig` 自 `AgentDeps.emitAppEvent` 透传；
   * 未接线时不携带,每轮发送前事件不发射、循环零开销）
   *
   * 已接线时每轮 provider 调用前（历史裁剪/压缩之前）发射
   * [appEventBus](../../faapi/src/events/appEventBus.md) 的 `agent:input` /
   * `agent:input:<agentName>`——载荷为历史只读快照 + `addInput` 补充输入（片段
   * 落账进历史,append-only 不可变）。见 reactLoop.md「agent:input 每轮发送前
   * 事件（历史编辑窗口）」。
   */
  appEvent?: {
    emit: AppEventEmitter;
    agentName: string;
    depth: number;
    ctx: AgentToolContext;
    /**
     * `agent:root-input` 的暂存器（`buildLoopConfig` 对非空 input 发射事件后挂载）——
     * loop 首轮 `agent:input` 直接复用同一暂存器，两路片段一起合并落账进首条 user
     * 消息；仅首轮消费，后续轮不参与。纯续跑（无新输入）不挂载。
     */
    rootInputStaging?: InputStaging;
  };
}

/**
 * 非流式循环结果
 */
export interface ReactLoopResult {
  /** 最终 assistant 消息内容 */
  content: string;
  /**
   * 最终 assistant 的推理内容（thinking 模型，多轮时中间轮的推理不保留；
   * 无推理内容时不存在）。历史 messages 中的 assistant 消息已剥离推理内容，
   * 仅此字段与 trace 的 `llm_call.response.reasoning_content` 可读。
   */
  reasoning?: string;
  /** 完整对话历史（system + user + assistant + tool 消息） */
  messages: LLMMessage[];
  /**
   * 使用的轮数（整树口径：主循环轮数 + 全部 sub-agent 循环轮数）。
   * `maxTurns` 循环控制与 trace 事件的 `turn` 序号只按主循环计（子代理轮数不挤占父循环预算）。
   */
  turns: number;
  /** 最终轮的停止原因 */
  stopReason: LLMStopReason;
  /**
   * 累计 token 用量（整树口径：本次 run 全部 `llm_call` usage 之和,含全部层级的
   * sub-agent 循环;provider 不返回用量时为 `undefined`）。
   * 详见 reactLoop.md「usage 与 turns 的整树口径」。
   */
  usage?: LLMUsage;
  /**
   * 结构化调用明细（`enableTracing=true` 时填充,否则 `undefined` 零开销）。
   * 详见 [trace.md](./trace.md)。
   */
  trace?: AgentTrace;
  /**
   * 层级追踪 ID（详见 [traceId.md](./traceId.md)）
   *
   * Agent 层在循环返回后填充（reactLoop 不感知——traceId 是 agent 调用概念,
   * 非循环概念）;`config.agent.traceId: false` 且未显式传 `options.traceId` 时
   * `undefined`。流式路径经 `done` chunk 携带（同字段语义）。
   */
  traceId?: string;
}

/**
 * 流式循环的单个 chunk
 *
 * 每个 chunk 至多含一个字段：
 * - `deltaContent` — LLM 增量 token（多次 yield）
 * - `deltaReasoning` — LLM 推理内容增量（thinking 模型，含中间 tool 轮）
 * - `toolCall` — tool 开始执行
 * - `toolResult` — tool 执行完成
 * - `traceEvent` — trace 事件（`enableTracing=true` 时增量推送,与上述字段互斥）
 * - `done` — 循环结束（只 yield 一次）
 */
export interface ReactLoopStreamChunk {
  /** LLM 增量 token */
  deltaContent?: string;
  /** LLM 推理内容增量（thinking 模型，见 reactLoop.md thinking 章节） */
  deltaReasoning?: string;
  /** tool 开始执行（LLM 请求调用 tool） */
  toolCall?: { name: string; arguments: Record<string, unknown> };
  /** tool 执行完成（含结果） */
  toolResult?: { name: string; result: string };
  /**
   * 嵌套子代理循环的增量（冒泡透传;仅流式路径）。
   * 详见 reactLoop.md「子代理 delta 冒泡」章节。
   */
  subagentDelta?: SubAgentDelta;
  /**
   * trace 事件（`enableTracing=true` 时增量推送）。
   * 与 deltaContent / deltaReasoning / toolCall / toolResult / subagentDelta / done 互斥,一个 chunk 至多一个字段。
   */
  traceEvent?: AgentTraceEvent;
  /** 循环结束 */
  done?: {
    content: string;
    /** 最终轮的完整推理内容（thinking 模型；无推理内容时不存在） */
    reasoning?: string;
    /** 整树口径（主循环 + 全部 sub-agent 循环），与 ReactLoopResult.turns 一致 */
    turns: number;
    stopReason: LLMStopReason;
    /** 整树口径（全部 llm_call 之和），与 ReactLoopResult.usage 一致 */
    usage?: LLMUsage;
    /** 层级追踪 ID（Agent 层填充,与 ReactLoopResult.traceId 同语义,见 traceId.md） */
    traceId?: string;
    /**
     * 最终完整对话历史（含最终 assistant 消息，推理内容已剥离），与非流式
     * `ReactLoopResult.messages` 同源对齐——流式消费方持久化后经
     * `config.messages` 续跑（挂起/恢复编排），不必走异常路径取断点状态。
     * 满足轮组原子性（assistant.toolCalls 与 tool 结果完整配对），可直接回传
     */
    messages: LLMMessage[];
  };
}

/**
 * reactLoop 系统级错误
 *
 * 目前仅用于 `maxTurns` 超限。tool 执行错误不抛此类型——它们被 catch 后回传 LLM。
 */
export class ReactLoopError extends Error {
  /** 配置的 maxTurns 值 */
  readonly maxTurns: number;
  /** 超限时的完整对话历史（业务方可提高 maxTurns 后经 `config.messages` 续跑，轮数重新计数） */
  readonly messages: LLMMessage[];

  constructor(message: string, maxTurns: number, messages: LLMMessage[] = []) {
    super(message);
    this.name = 'ReactLoopError';
    this.maxTurns = maxTurns;
    this.messages = messages;
  }
}

/** 默认最大轮数 */
const DEFAULT_MAX_TURNS = 10;

/** 把 tool 执行结果转为字符串（非 string 自动 JSON.stringify） */
function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return '';
  return JSON.stringify(result);
}

/** 把 tool 执行错误转为字符串 */
function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 剥离 assistant 消息上的 `reasoning_content`（历史保持 OpenAI 线格式纯净）
 *
 * 推理内容只透出给调用方（`ReactLoopResult.reasoning` / `deltaReasoning` / trace 的
 * `llm_call.response`），不进入对话历史——历史是发给 LLM 的（DeepSeek 多轮回传推理
 * 内容直接 400）也是持久化 / 续跑 / `AgentAbortError.messages` / `ReactLoopError.messages`
 * 的来源。无该字段时原引用返回（零拷贝常态路径）。
 */
function stripReasoning(message: LLMMessage): LLMMessage {
  if (message.reasoning_content === undefined) return message;
  const { reasoning_content: _stripped, ...rest } = message;
  return rest;
}

/** 累加 usage */
function accumulateUsage(a: LLMUsage | undefined, b: LLMUsage): LLMUsage {
  if (!a) return { ...b };
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}

/** 构造初始 messages（可选 system + user input） */
function buildInitialMessages(input: string, systemPrompt?: string): LLMMessage[] {
  const messages: LLMMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: input });
  return messages;
}

/**
 * 解析 tool_call 的 `function.arguments`（OpenAI 线格式 JSON 字符串）为对象
 *
 * 解析边界收敛在此——tool 执行函数 / 鉴权钩子 / trace 事件拿到的都是已 parse 的对象。
 * 解析失败抛错，由调用方的 tool 错误路径 catch 后回传 LLM（LLM 可修正参数重试）。
 */
function parseToolCallArguments(toolCall: LLMToolCall): Record<string, unknown> {
  const raw = toolCall.function.arguments;
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * 构造循环初始 messages（含续跑语义，见 reactLoop.md 中断恢复章节）
 *
 * - `config.messages` 提供（续跑 / 多轮对话）：以其为基础——历史无 `system` 时
 *   自动前置 `systemPrompt`（agent 人格不因续跑丢失）；非空 `input` 追加为新的
 *   user 消息，空 input 纯续跑
 * - 未提供：`systemPrompt`（可选）+ user input（现状行为，input 为空时 user 内容为空串，
 *   输入守卫由 Agent 层负责）
 */
function initLoopMessages(input: string | undefined, config: ReactLoopConfig): LLMMessage[] {
  if (config.messages?.length) {
    // 剥离上游 reasoning_content（推理内容不进对话历史，见 stripReasoning）
    const messages = config.messages.map(stripReasoning);
    if (config.systemPrompt && !messages.some((m) => m.role === 'system')) {
      messages.unshift({ role: 'system', content: config.systemPrompt });
    }
    if (input) {
      messages.push({ role: 'user', content: input });
    }
    return messages;
  }
  return buildInitialMessages(input ?? '', config.systemPrompt);
}

/** 构造 LLM complete/stream 请求参数（除 messages 外的公共字段） */
/** 近似 token 估算：字符数 / 2（中英混合保守值，不引入 tokenizer 依赖） */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 2);
}

function estimateMessageTokens(message: LLMMessage): number {
  let chars = message.content.length;
  if (message.tool_calls) {
    chars += JSON.stringify(message.tool_calls).length;
  }
  if (message.tool_call_id) {
    chars += message.tool_call_id.length;
  }
  return estimateTokens(chars);
}

/** 合法消息角色（循环历史结构校验用） */
const VALID_MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * 循环历史结构校验：消息角色合法 + `assistant.tool_calls` 与 tool 结果按
 * `tool_call_id` 配对完整
 *
 * 两个消费方同一约束——Agent 层续跑入参校验（label `'resume history'`）与
 * 超限事件 `replace` 产物校验（label `'replaced history'`）：断裂结构每次
 * 发送都会被 provider 400,在入口显式失败（fail fast,不静默放行）。
 */
export function validateLoopHistory(messages: LLMMessage[], label: string): void {
  messages.forEach((message, index) => {
    if (!VALID_MESSAGE_ROLES.has(message.role)) {
      throw new AgentError(
        `Invalid ${label} at messages[${index}]: unknown role "${String(message.role)}"`,
      );
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const missing = new Set(message.tool_calls.map((call) => call.id));
      for (let j = index + 1; j < messages.length && messages[j]!.role === 'tool'; j++) {
        missing.delete(messages[j]!.tool_call_id ?? '');
      }
      if (missing.size > 0) {
        throw new AgentError(
          `Invalid ${label} at messages[${index}]: assistant tool call(s) [${Array.from(missing).join(', ')}] have no matching tool result (history truncated mid-turn — persist the full turn group from AgentAbortError.messages / ReactLoopError.messages)`,
        );
      }
    }
    if (message.role === 'tool') {
      // 孤立 tool 结果:前溯连续 tool 段之外的最近消息必须是其 tool_call_id 的属主 assistant
      let start = index;
      while (start > 0 && messages[start - 1]!.role === 'tool') start--;
      const owner = start > 0 ? messages[start - 1] : undefined;
      const owned =
        owner?.role === 'assistant' &&
        owner.tool_calls?.some((call) => call.id === (message.tool_call_id ?? ''));
      if (!owned) {
        throw new AgentError(
          `Invalid ${label} at messages[${index}]: orphan tool result (tool_call_id "${String(
            message.tool_call_id ?? '',
          )}") has no preceding assistant tool_calls owning it`,
        );
      }
    }
  });
}

/**
 * agent:history-over-budget 历史超限事件（见主包 events/appEventBus.md 与
 * reactLoop.md 同名章节）
 *
 * 每轮估算（字符数/2）超过 `maxHistoryTokens` 阈值时发射（agent:input 落账之后）,
 * 通用名 + 专属名同一载荷对象先通用后专属。载荷 `messages` 为历史只读快照;
 * 订阅端经 `replace(history)` 用压缩产物整体替换循环历史——扇出结束后校验
 * （非空 + 结构完整）后落账,后续轮次 / result.messages / 断点续跑链全可见;
 * 多 handler 后调覆盖先调,不调 = 历史原样发送。当轮至多发射一次（替换后不重入）,
 * 后续轮次重新估算、仍超限再发。未设置阈值 / 未超限 / appEvent 未接线时不发射
 * （能力边界,非降级——未订阅时超限历史原样发送,长度控制是业务知识）。
 * handler 抛错走 run/stream 既有错误链,替换未发生,历史零污染（事务性）。
 */
async function emitHistoryOverBudgetEvent(
  messages: LLMMessage[],
  config: ReactLoopConfig,
): Promise<void> {
  const budget = config.maxHistoryTokens;
  const appEvent = config.appEvent;
  if (!budget || !appEvent) return;
  const estimatedTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  if (estimatedTokens <= budget) return;
  let replaced: LLMMessage[] | undefined;
  let readView: readonly LLMMessage[] | undefined;
  const payload = {
    depth: appEvent.depth,
    estimatedTokens,
    budget,
    ctx: appEvent.ctx,
    get messages(): readonly LLMMessage[] {
      return (readView ??= createReadView(messages));
    },
    replace: (history: LLMMessage[]): void => {
      replaced = history;
    },
  };
  await appEvent.emit(APP_EVENT.agentHistoryOverBudget, payload);
  await appEvent.emit(agentHistoryOverBudgetEventName(appEvent.agentName), payload);
  // —— 扇出结束,此刻落账（多 handler 后调覆盖先调;不调 = 原样发送）——
  if (!replaced) return;
  if (!Array.isArray(replaced) || replaced.length === 0) {
    throw new AgentError(
      'agent:history-over-budget replace() requires a non-empty message array (the compacted replacement history)',
    );
  }
  validateLoopHistory(replaced, 'replaced history');
  messages.length = 0;
  messages.push(...replaced);
}

/** 补充输入片段的原输入占位符：落账拼接时展开为当轮输入原内容（见 reactLoop.md） */
const RAW_INPUT_PLACEHOLDER = '{{rawInput}}';

/** 补充输入片段缺省排序序号（中位锚点：显式小号插前、大号插后） */
const DEFAULT_INPUT_INDEX = 100;

/** 补充输入片段暂存形态（seq 为调用序——同 index 的稳定 tiebreak 键） */
export interface StagedInput {
  /** 排序序号（缺省 DEFAULT_INPUT_INDEX） */
  index: number;
  /** 片段文本（框架不包裹不转义，标签包裹是订阅端自己的事） */
  text: string;
  /** 调用序（同 index 保持调用序——双键比较器显式写进排序，不依赖引擎稳定排序） */
  seq: number;
}

/**
 * 补充输入暂存器——`agent:root-input`（循环启动前，`buildLoopConfig` 创建）与
 * `agent:input`（每轮）共用的 `addInput` 写面实现。loop 首轮两事件共用同一个暂存器：
 * root-input 片段先暂存（seq 更小），首轮 `agent:input` 片段续接同一数组，扇出结束
 * 后一次排序 / 过滤 / 拼接 / 落账（同 index 下 root-input 片段在前）。
 */
export interface InputStaging {
  /** 暂存片段（排序在落账时统一进行） */
  readonly staged: StagedInput[];
  /** 事件载荷直接挂载的 `addInput` 实现 */
  addInput(text: string, index?: number): void;
}

/** 创建空暂存器（每次事件发射 / 每个 loop 首轮各自独立，永不跨边界复用） */
export function createInputStaging(): InputStaging {
  const staged: StagedInput[] = [];
  return {
    staged,
    addInput: (text, index = DEFAULT_INPUT_INDEX) => {
      staged.push({ index, text, seq: staged.length });
    },
  };
}

/**
 * 历史只读快照：深拷贝 + 逐层深冻结
 *
 * 读取与真历史内容完全一致，而任何写操作（数组结构变更 / 消息对象字段赋值）
 * 都抛 TypeError——历史本体从不出境，写穿面在结构上不存在。
 */
function createReadView(messages: LLMMessage[]): readonly LLMMessage[] {
  const clone = structuredClone(messages) as LLMMessage[];
  const freezeDeep = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) freezeDeep(item);
      Object.freeze(value);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) freezeDeep(item);
      Object.freeze(value);
    }
  };
  freezeDeep(clone);
  return clone;
}

/**
 * agent:input 每轮发送前事件——历史编辑窗口（见主包 events/appEventBus.md 与
 * reactLoop.md 同名章节）
 *
 * appEvent 已接线时每轮发射（历史裁剪/压缩**之前**——片段落账后才投影发送），
 * 通用名 + 专属名同一载荷对象先通用后专属。载荷 `messages` 为历史只读快照
 * （深冻结克隆，首次访问才构造——订阅端不读则零拷贝开销），`addInput(text,
 * index=100)` 暂存补充输入片段。
 *
 * 暂存器选择：当轮有新输入（`turnInputIndex >= 0`，即 loop 首轮）复用
 * `appEvent.rootInputStaging`——`agent:root-input` 在循环启动前已把片段暂存在同一
 * 数组里，本轮 addInput 续接其后（seq 连续），两路片段一起落账；其余轮次（工具轮 /
 * 纯续跑轮）各自新建暂存器，root-input 片段不参与。
 *
 * 扇出结束后落账：片段按 (index, seq) 升序排序（同 index 保持调用序）→ 过滤
 * 空白片段 → `'\n\n'` 拼接 → 前置进当轮输入消息（`turnInputIndex >= 0`，原内容
 * 逐字节不动）；当轮无新输入（工具轮/纯续跑轮，-1）为新增 user 消息追加。
 * 落账即进对话历史——后续轮次 / result.messages / 断点续跑链全部可见，不可变。
 *
 * handler 抛错 → emit 冒泡走 run/stream 既有错误链，尚未落账，历史零污染
 * （事务性 all-or-nothing）。appEvent 未接线时整体跳过（能力边界，非降级）。
 */
async function emitAgentInputEvent(
  messages: LLMMessage[],
  config: ReactLoopConfig,
  turnInputIndex: number,
): Promise<void> {
  const appEvent = config.appEvent;
  if (!appEvent) return;
  const staging =
    turnInputIndex >= 0 && appEvent.rootInputStaging
      ? appEvent.rootInputStaging
      : createInputStaging();
  let readView: readonly LLMMessage[] | undefined;
  const payload = {
    depth: appEvent.depth,
    ctx: appEvent.ctx,
    get messages(): readonly LLMMessage[] {
      return (readView ??= createReadView(messages));
    },
    addInput: staging.addInput,
  };
  await appEvent.emit(APP_EVENT.agentInput, payload);
  await appEvent.emit(agentInputEventName(appEvent.agentName), payload);
  // —— 扇出结束，此刻起落账（此后任何路径都不会留下「半次编辑」）——
  const joined = staging.staged
    .sort((a, b) => a.index - b.index || a.seq - b.seq)
    .map((s) => s.text)
    .filter((t) => t.trim() !== '')
    .join('\n\n');
  if (joined === '') return;
  if (turnInputIndex >= 0) {
    const current = messages[turnInputIndex]!;
    // {{rawInput}} 占位符：原输入嵌在订阅端指定位置（与缀尾互斥——占位符在场即不缀尾,
    // 如 '规则…\n\n<user_input>{{rawInput}}</user_input>'）;单次展开不递归
    // （原内容含字面占位符不再二次处理）。不含占位符 = 现状（前置 + 原内容缀尾）
    const raw = current.content;
    messages[turnInputIndex] = {
      ...current,
      content: joined.includes(RAW_INPUT_PLACEHOLDER)
        ? joined.split(RAW_INPUT_PLACEHOLDER).join(raw)
        : `${joined}\n\n${raw}`,
    };
  } else {
    // 无当轮输入（工具轮/纯续跑轮）：占位符无原值可嵌,展开为空串;
    // 展开后全空白则不新增消息（同空片段过滤口径）
    const content = joined.split(RAW_INPUT_PLACEHOLDER).join('');
    if (content.trim() !== '') {
      messages.push({ role: 'user', content });
    }
  }
}

function buildRequestExtras(config: ReactLoopConfig) {
  return {
    tools: config.tools,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}

/** 当前时间戳（performance.now() ms,相对进程启动） */
function nowMs(): number {
  return performance.now();
}

/**
 * 从 sub-agent tool 名提取 agent 名
 *
 * sub-agent tool 命名约定:`agent-<agentName>`（见 [subAgentToolName](../../faapi/src/injection/subAgentToolName.md)）。
 * agent 名与派发名一一对应（目录段禁用 `_`、覆盖名校验过字符集）,剥前缀即精确还原;
 * 非该前缀的原样返回（用于业务方自定义 sub-agent tool 命名）。
 */
function extractSubAgentName(toolName: string): string {
  const prefix = 'agent-';
  if (toolName.startsWith(prefix)) {
    return toolName.slice(prefix.length);
  }
  return toolName;
}

// ─── reactLoop（非流式）──────────────────────────────

/**
 * 执行 ReAct 循环（非流式）
 *
 * 反复调 `provider.complete()` → 执行 tool → 回传结果，直到 LLM 返回 `stop`（或其他非 `tool_calls` 原因）或超出 `maxTurns`。
 *
 * @param input 用户输入（续跑场景可为空，历史经 `config.messages` 提供）
 * @param config 循环配置
 * @returns 最终结果（content + reasoning + messages + turns + stopReason + usage）
 * @throws {ReactLoopError} 超出 maxTurns（`error.messages` 携带完整历史，可续跑）
 * @throws {AgentAbortError} 中断（`error.messages` 携带断点历史，可续跑）
 * @throws {Error} provider.complete 抛错时立即传播
 */
export async function reactLoop(
  input: string | undefined,
  config: ReactLoopConfig,
): Promise<ReactLoopResult> {
  const enableTracing = config.enableTracing ?? false;
  const messages = initLoopMessages(input, config);
  // 当轮输入消息下标（仅首轮有意义）：非空 input 时 initLoopMessages 把新输入
  // 追加为末条 user 消息；纯续跑（无 input）无「当轮输入」→ -1,片段走新增 user 消息
  const turnInputIndex = input ? messages.length - 1 : -1;
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  const extras = buildRequestExtras(config);
  let totalUsage: LLMUsage | undefined;
  /** 最终轮 assistant 的推理内容（thinking 模型；每轮覆盖，循环结束时即最终轮值） */
  let finalReasoning: string | undefined;
  /** 主循环轮数——循环控制（maxTurns）与事件 turn 序号的唯一依据 */
  let loopTurns = 0;
  /** 子树轮数累计（SubAgentToolResult 上卷）——结果 turns = loopTurns + subTurns */
  let subTurns = 0;

  // trace 采集容器（enableTracing=false 时不构造,零开销）
  const traceStartedAt = enableTracing ? nowMs() : 0;
  const traceEvents: AgentTraceEvent[] | undefined = enableTracing ? [] : undefined;

  while (loopTurns < maxTurns) {
    // 取消预检查：已取消则不再发起本轮 LLM 调用（携带断点历史供续跑）
    if (config.signal?.aborted) {
      throw new AgentAbortError(undefined, messages);
    }
    loopTurns++;

    const llmStartedAt = enableTracing ? nowMs() : 0;
    // agent:input 每轮发送前事件（先于超限事件）：历史只读快照 + addInput 补充输入,
    // 扇出结束落账进历史本体;随后历史超限事件（超 maxHistoryTokens 阈值时发射,
    // 订阅端 replace 整体替换循环历史——框架零内置裁剪）;发送 = 历史本体
    await emitAgentInputEvent(messages, config, loopTurns === 1 ? turnInputIndex : -1);
    await emitHistoryOverBudgetEvent(messages, config);
    const outgoingMessages = [...messages];
    // 浅拷贝快照:该轮发给 LLM 的输入消息（数组新对象,消息对象引用共享）
    const inputSnapshot = enableTracing ? [...outgoingMessages] : undefined;
    // 执行中取消由 provider 请求中断传播——附上断点历史重抛（不含未完成的 assistant 消息，
    // 轮组原子性见 reactLoop.md 中断恢复章节）
    let response: LLMResponse;
    try {
      response = await config.provider.complete({
        messages: [...outgoingMessages],
        ...extras,
        signal: config.signal,
      });
    } catch (err) {
      if (err instanceof AgentAbortError) {
        throw new AgentAbortError(err.message, messages);
      }
      throw err;
    }

    if (response.usage) {
      totalUsage = accumulateUsage(totalUsage, response.usage);
    }

    if (enableTracing) {
      const llmEndedAt = nowMs();
      traceEvents!.push({
        type: 'llm_call',
        turn: loopTurns,
        startedAt: llmStartedAt,
        durationMs: llmEndedAt - llmStartedAt,
        model: config.model ?? '',
        inputMessages: inputSnapshot!,
        // 原始 assistant 消息（含 reasoning_content）——trace 保留完整 LLM 返回，
        // 与历史剥离策略互补（见 trace.md「llm_call.response 与 thinking」）
        response: response.message,
        stopReason: response.stopReason,
        usage: response.usage,
      });
    }

    // 把 assistant 消息加入历史（剥离 reasoning_content——推理内容不进对话历史，
    // 见 stripReasoning 与 reactLoop.md thinking 章节）
    finalReasoning = response.message.reasoning_content;
    messages.push(stripReasoning(response.message));

    // 非 tool_calls → 循环结束
    if (response.stopReason !== 'tool_calls' || !response.message.tool_calls) {
      const traceEndedAt = enableTracing ? nowMs() : 0;
      const turns = loopTurns + subTurns;
      const result: ReactLoopResult = {
        content: response.message.content,
        messages,
        turns,
        stopReason: response.stopReason,
        usage: totalUsage,
        trace: enableTracing
          ? {
              agentName: '',
              startedAt: traceStartedAt,
              durationMs: traceEndedAt - traceStartedAt,
              turns,
              usage: totalUsage,
              stopReason: response.stopReason,
              content: response.message.content,
              events: traceEvents!,
            }
          : undefined,
      };
      if (finalReasoning !== undefined) {
        result.reasoning = finalReasoning;
      }
      return result;
    }

    // 并行执行同轮全部 tool_call——多个独立 tool 的总耗时从「各 tool 之和」
    // 降为「最慢一个」。每个 toolCall 独立 try/catch（单个失败不影响其余），
    // 结果按下方的 tool_calls 声明顺序回传（与完成顺序无关，保证 tool 配对语义）。
    // 注：beforeToolCall/afterToolCall 钩子会并发触发，业务方钩子不应依赖调用顺序。
    // 流式路径（reactLoopStream）保持串行——yield 顺序受消费端约束。
    // arguments 解析边界在此收拢：线格式 JSON 字符串在此 parse，执行函数 /
    // 鉴权钩子 / trace 事件拿到的都是已 parse 的对象；解析失败走 tool 错误路径回传。
    const settled = await Promise.all(
      response.message.tool_calls.map(async (toolCall) => {
        const toolStartedAt = enableTracing ? nowMs() : 0;
        const toolName = toolCall.function.name;
        let args: Record<string, unknown> = {};
        let resultStr: string;
        let rawResult: unknown | TracingToolResult;
        let toolErr: unknown;
        let hasError = false;
        try {
          args = parseToolCallArguments(toolCall);
          rawResult = await config.executeTool(toolName, args);
          // SubAgentToolResult / 旧 TracingToolResult:剥壳取 result 作为 tool 消息内容
          if (isSubAgentToolResult(rawResult)) {
            resultStr = stringifyResult(rawResult.result);
          } else if (isTracingToolResult(rawResult)) {
            resultStr = stringifyResult(rawResult.result);
          } else {
            resultStr = stringifyResult(rawResult);
          }
        } catch (err) {
          hasError = true;
          toolErr = err;
          resultStr = stringifyError(err);
          rawResult = undefined;
        }
        // 结束时间在各自闭包内取——并行执行时若在 Promise.all 之后的串行循环里
        // 统一取,每个 tool 的 durationMs 都会包含等待其他 tool 的时间（全部失真
        // 为「最慢 tool」的耗时）
        const toolEndedAt = enableTracing ? nowMs() : 0;
        return {
          toolCall,
          toolName,
          args,
          toolStartedAt,
          toolEndedAt,
          resultStr,
          rawResult,
          toolErr,
          hasError,
        };
      }),
    );

    for (const {
      toolCall,
      toolName,
      args,
      toolStartedAt,
      toolEndedAt,
      resultStr,
      rawResult,
      toolErr,
      hasError,
    } of settled) {
      // 整树上卷：sub-agent 结果的 usage/turns 累加进父循环（usage 台账不依赖 tracing 开关）
      if (isSubAgentToolResult(rawResult)) {
        if (rawResult.usage) {
          totalUsage = accumulateUsage(totalUsage, rawResult.usage);
        }
        if (typeof rawResult.turns === 'number') {
          subTurns += rawResult.turns;
        }
      }
      if (enableTracing) {
        if (isSubAgentToolResult(rawResult) && rawResult.trace) {
          // sub-agent 调用（新结构）:嵌入 sub-trace
          traceEvents!.push({
            type: 'subagent_call',
            turn: loopTurns,
            startedAt: toolStartedAt,
            durationMs: toolEndedAt - toolStartedAt,
            toolCallId: toolCall.id,
            agentName: extractSubAgentName(toolName),
            input: JSON.stringify(args),
            trace: rawResult.trace,
            result: resultStr,
          });
        } else if (isTracingToolResult(rawResult)) {
          // sub-agent 调用(旧 TracingToolResult,兼容存量自定义 executeTool):嵌入 sub-trace
          traceEvents!.push({
            type: 'subagent_call',
            turn: loopTurns,
            startedAt: toolStartedAt,
            durationMs: toolEndedAt - toolStartedAt,
            toolCallId: toolCall.id,
            agentName: extractSubAgentName(toolName),
            input: JSON.stringify(args),
            trace: rawResult.trace,
            result: resultStr,
          });
        } else {
          traceEvents!.push({
            type: 'tool_call',
            turn: loopTurns,
            startedAt: toolStartedAt,
            durationMs: toolEndedAt - toolStartedAt,
            toolCallId: toolCall.id,
            name: toolName,
            arguments: args,
            result: resultStr,
            error: hasError ? stringifyError(toolErr) : undefined,
          });
        }
      }

      messages.push({
        role: 'tool',
        content: resultStr,
        tool_call_id: toolCall.id,
      });
    }
  }

  throw new ReactLoopError(
    `Max turns (${maxTurns}) exceeded — agent did not converge to a final answer`,
    maxTurns,
    messages,
  );
}

// ─── reactLoopStream（流式）──────────────────────────

/**
 * 执行 ReAct 循环（流式）
 *
 * 使用 `provider.stream()` 异步迭代 chunks，yield `deltaContent` + `deltaReasoning` + `toolCall` + `toolResult` + `done`。
 *
 * @param input 用户输入（续跑场景可为空，历史经 `config.messages` 提供）
 * @param config 循环配置
 * @yields {ReactLoopStreamChunk} 流式 chunk
 * @throws {ReactLoopError} 超出 maxTurns（`error.messages` 携带完整历史，可续跑）
 * @throws {AgentAbortError} 中断（`error.messages` 携带断点历史，可续跑）
 * @throws {Error} provider.stream 抛错时立即传播
 */
export async function* reactLoopStream(
  input: string | undefined,
  config: ReactLoopConfig,
): AsyncIterable<ReactLoopStreamChunk> {
  const enableTracing = config.enableTracing ?? false;
  const messages = initLoopMessages(input, config);
  // 当轮输入消息下标（仅首轮有意义）：非空 input 时 initLoopMessages 把新输入
  // 追加为末条 user 消息；纯续跑（无 input）无「当轮输入」→ -1,片段走新增 user 消息
  const turnInputIndex = input ? messages.length - 1 : -1;
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  const extras = buildRequestExtras(config);
  let totalUsage: LLMUsage | undefined;
  /** 主循环轮数——循环控制（maxTurns）与事件 turn 序号的唯一依据 */
  let loopTurns = 0;
  /** 子树轮数累计（SubAgentToolResult 上卷）——done.turns = loopTurns + subTurns */
  let subTurns = 0;

  while (loopTurns < maxTurns) {
    // 取消预检查：已取消则不再发起本轮 LLM 调用（携带断点历史供续跑）
    if (config.signal?.aborted) {
      throw new AgentAbortError(undefined, messages);
    }
    loopTurns++;

    const llmStartedAt = enableTracing ? nowMs() : 0;
    // agent:input 每轮发送前事件（先于超限事件）：历史只读快照 + addInput 补充输入,
    // 扇出结束落账进历史本体;随后历史超限事件（超 maxHistoryTokens 阈值时发射,
    // 订阅端 replace 整体替换循环历史——框架零内置裁剪）;发送 = 历史本体
    await emitAgentInputEvent(messages, config, loopTurns === 1 ? turnInputIndex : -1);
    await emitHistoryOverBudgetEvent(messages, config);
    const outgoingMessages = [...messages];
    // 浅拷贝快照:该轮发给 LLM 的输入消息（数组新对象,消息对象引用共享）
    const inputSnapshot = enableTracing ? [...outgoingMessages] : undefined;
    let turnContent = '';
    let turnReasoning = '';
    let toolCalls: LLMToolCall[] | undefined;
    let finishReason: LLMStopReason | undefined;
    let turnUsage: LLMUsage | undefined;

    // 执行中取消由 provider 流中断传播——附上断点历史重抛。当前轮已 yield 的部分
    // deltaContent 属于未完成轮组，不入历史（轮组原子性见 reactLoop.md 中断恢复章节）
    try {
      for await (const chunk of config.provider.stream({
        messages: [...outgoingMessages],
        ...extras,
        signal: config.signal,
      })) {
        // 推理内容增量（thinking 模型，中间 tool 轮同样透出——业务方可完整展示思考过程）
        if (typeof chunk.deltaReasoning === 'string' && chunk.deltaReasoning.length > 0) {
          turnReasoning += chunk.deltaReasoning;
          yield { deltaReasoning: chunk.deltaReasoning };
        }

        // 增量内容
        if (typeof chunk.deltaContent === 'string' && chunk.deltaContent.length > 0) {
          turnContent += chunk.deltaContent;
          yield { deltaContent: chunk.deltaContent };
        }

        // tool_calls（在最终 chunk 出现，含 id/name/arguments）
        if (chunk.toolCalls && chunk.toolCalls.length > 0) {
          toolCalls = chunk.toolCalls;
        }

        // finishReason + usage（在最终 chunk 出现）
        if (chunk.finishReason) {
          finishReason = chunk.finishReason;
        }
        if (chunk.usage) {
          // 覆盖式取值:单轮流内以最后出现的 usage 为准——OpenAI 官方只在最终 chunk
          // 回 usage(单次覆盖等价),部分 OpenAI 兼容网关按流式惯例每 chunk 回**累计**
          // usage(逐 chunk 累加会把台账放大数倍)。整树口径的跨轮累加在该轮流结束、
          // 提交 turnUsage 时进行(下方 done/trace 消费处单次累加)
          turnUsage = chunk.usage;
        }
      }
    } catch (err) {
      if (err instanceof AgentAbortError) {
        throw new AgentAbortError(err.message, messages);
      }
      throw err;
    }

    // 本轮 usage 单次提交总台账（流内多个 usage chunk 已在 turnUsage 覆盖收敛,
    // 官方单 chunk 与网关累计 chunk 两种惯例下口径一致）
    if (turnUsage) {
      totalUsage = accumulateUsage(totalUsage, turnUsage);
    }

    // 把 assistant 消息加入历史（含 tool_calls，供下一轮 LLM 上下文；规范形，
    // function.arguments 保持线格式 JSON 字符串；本就是新构造对象，天然无推理内容）
    const assistantMessage: LLMMessage = {
      role: 'assistant',
      content: turnContent,
    };
    if (toolCalls) {
      assistantMessage.tool_calls = toolCalls;
    }
    messages.push(assistantMessage);

    if (enableTracing) {
      const llmEndedAt = nowMs();
      // trace 保留该轮完整 LLM 返回（含累积的推理内容），与历史剥离互补；
      // 无推理内容时不拷贝（零开销常态路径）
      const tracedResponse = turnReasoning
        ? { ...assistantMessage, reasoning_content: turnReasoning }
        : assistantMessage;
      yield {
        traceEvent: {
          type: 'llm_call',
          turn: loopTurns,
          startedAt: llmStartedAt,
          durationMs: llmEndedAt - llmStartedAt,
          model: config.model ?? '',
          inputMessages: inputSnapshot!,
          response: tracedResponse,
          stopReason: finishReason ?? 'other',
          usage: turnUsage,
        },
      };
    }

    // 非 tool_calls → 循环结束
    if (finishReason !== 'tool_calls' || !toolCalls) {
      // 此刻 messages 已含最终 assistant 消息——与非流式 return 的历史同源
      // （同一条本地数组），流式收尾导出供挂起/恢复编排持久化续跑
      const donePayload: NonNullable<ReactLoopStreamChunk['done']> = {
        content: turnContent,
        turns: loopTurns + subTurns,
        stopReason: finishReason ?? 'other',
        usage: totalUsage,
        messages,
      };
      if (turnReasoning) {
        donePayload.reasoning = turnReasoning;
      }
      yield { done: donePayload };
      return;
    }

    // 执行每个 tool call（arguments 解析边界与非流式路径一致：先 parse，
    // 解析失败走 tool 错误路径回传 LLM）
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      const toolStartedAt = enableTracing ? nowMs() : 0;
      let args: Record<string, unknown> = {};
      let resultStr: string;
      let rawResult: unknown | TracingToolResult;
      let toolErr: unknown;
      let hasError = false;
      // 子代理 delta 泵（fire-and-drain）：`await executeTool` 期间 async generator
      // 挂起无法 yield——先 fire 执行（携带 emitter,执行方 push 进队列并唤醒）,
      // generator 侧循环 drain 队列逐个 yield subagentDelta,执行完成后 flush 剩余。
      // 错误延后到 drain 结束后 await 重抛,走既有 tool 错误路径（已 emit 的 delta 不丢）
      const pendingDeltas: SubAgentDelta[] = [];
      let wakeDrain: (() => void) | null = null;
      const deltaEmitter: SubAgentDeltaEmitter = {
        onSubAgentDelta: (delta) => {
          pendingDeltas.push(delta);
          const wake = wakeDrain;
          wakeDrain = null;
          wake?.();
        },
      };
      try {
        args = parseToolCallArguments(toolCall);
        yield { toolCall: { name: toolName, arguments: args } };
        const toolPromise = config.executeTool(toolName, args, deltaEmitter);
        const settled = toolPromise.then(
          () => true,
          () => true, // 错误延后重抛,此处只关心执行结束以收尾 drain
        );
        drain: for (;;) {
          while (pendingDeltas.length > 0) {
            yield { subagentDelta: pendingDeltas.shift()! };
          }
          if (await Promise.race([settled, new Promise<void>((r) => (wakeDrain = r))])) {
            break drain;
          }
        }
        rawResult = await toolPromise;
        // SubAgentToolResult / 旧 TracingToolResult:剥壳取 result 作为 tool 消息内容
        if (isSubAgentToolResult(rawResult)) {
          resultStr = stringifyResult(rawResult.result);
        } else if (isTracingToolResult(rawResult)) {
          resultStr = stringifyResult(rawResult.result);
        } else {
          resultStr = stringifyResult(rawResult);
        }
      } catch (err) {
        hasError = true;
        toolErr = err;
        resultStr = stringifyError(err);
        rawResult = undefined;
      }

      // 整树上卷：sub-agent 结果的 usage/turns 累加进父循环（usage 台账不依赖 tracing 开关）
      if (isSubAgentToolResult(rawResult)) {
        if (rawResult.usage) {
          totalUsage = accumulateUsage(totalUsage, rawResult.usage);
        }
        if (typeof rawResult.turns === 'number') {
          subTurns += rawResult.turns;
        }
      }

      yield { toolResult: { name: toolName, result: resultStr } };

      if (enableTracing) {
        const toolEndedAt = nowMs();
        if (isSubAgentToolResult(rawResult) && rawResult.trace) {
          // sub-agent 调用（新结构）:嵌入 sub-trace
          yield {
            traceEvent: {
              type: 'subagent_call',
              turn: loopTurns,
              startedAt: toolStartedAt,
              durationMs: toolEndedAt - toolStartedAt,
              toolCallId: toolCall.id,
              agentName: extractSubAgentName(toolName),
              input: JSON.stringify(args),
              trace: rawResult.trace,
              result: resultStr,
            },
          };
        } else if (isTracingToolResult(rawResult)) {
          // sub-agent 调用(旧 TracingToolResult,兼容存量自定义 executeTool):嵌入 sub-trace
          yield {
            traceEvent: {
              type: 'subagent_call',
              turn: loopTurns,
              startedAt: toolStartedAt,
              durationMs: toolEndedAt - toolStartedAt,
              toolCallId: toolCall.id,
              agentName: extractSubAgentName(toolName),
              input: JSON.stringify(args),
              trace: rawResult.trace,
              result: resultStr,
            },
          };
        } else {
          yield {
            traceEvent: {
              type: 'tool_call',
              turn: loopTurns,
              startedAt: toolStartedAt,
              durationMs: toolEndedAt - toolStartedAt,
              toolCallId: toolCall.id,
              name: toolName,
              arguments: args,
              result: resultStr,
              error: hasError ? stringifyError(toolErr) : undefined,
            },
          };
        }
      }

      messages.push({
        role: 'tool',
        content: resultStr,
        tool_call_id: toolCall.id,
      });
    }
  }

  throw new ReactLoopError(
    `Max turns (${maxTurns}) exceeded — agent did not converge to a final answer`,
    maxTurns,
    messages,
  );
}
