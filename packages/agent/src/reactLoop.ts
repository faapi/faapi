import { AgentAbortError } from './provider';
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
 * - agent-as-tool（`agent.` 前缀）→ 递归调子 agent 的 reactLoop（`maxAgentDepth` 防护由 Agent 类在 `executeTool` 内实现），
 *   返回 [SubAgentToolResult](#subagenttoolresult)（携带子循环整树 `usage` / `turns` 供父循环上卷）
 *
 * 返回值可以是任意类型——非 string 会被 JSON.stringify 后回传 LLM。
 *
 * sub-agent 调用时,`SubAgentToolResult.trace` 存在（`enableTracing=true`）时
 * reactLoop 发出 `subagent_call` 事件（嵌套递归 trace）；旧 `TracingToolResult`
 * （`__trace` 标记,无用量字段）仍兼容识别,但不上卷用量。
 */
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
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
  /** 子循环整树 token 用量（自定义 run 的 sub-agent 无结构化用量,缺省 = 计 0） */
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
  /** 最大对话轮数（默认 10，来自 [AgentConfig](../../faapi/src/config/configTypes.md).maxTurns） */
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
   * 发送给 LLM 的历史 token 预算（近似估算：字符数 / 2；未设置 = 不裁剪，向后兼容）
   *
   * 超预算时从最旧的「轮组」（assistant + 其后全部 tool 结果）开始裁剪，
   * system 与初始 user 永不裁剪，至少保留最近一轮。裁剪只作用于发给 LLM 的
   * 消息副本，本地 `messages` 与 trace 不受影响。详见 reactLoop.md 的历史裁剪章节。
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
   * sub-agent 循环,自定义 run 的 sub-agent 计 0;provider 不返回时为 `undefined`）。
   * 详见 reactLoop.md「usage 与 turns 的整树口径」。
   */
  usage?: LLMUsage;
  /**
   * 结构化调用明细（`enableTracing=true` 时填充,否则 `undefined` 零开销）。
   * 详见 [trace.md](./trace.md)。
   */
  trace?: AgentTrace;
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
   * trace 事件（`enableTracing=true` 时增量推送）。
   * 与 deltaContent / deltaReasoning / toolCall / toolResult / done 互斥,一个 chunk 至多一个字段。
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
    // 剥离业务方历史上的 reasoning_content（推理内容不进对话历史，见 stripReasoning）
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

/**
 * 按预算裁剪发给 LLM 的历史（见 reactLoop.md 历史裁剪章节）
 *
 * - 头部保留段（system + 初始 user，直到第一个 assistant）永不裁剪
 * - 轮组（assistant + 其后全部 tool 结果）为原子单位，从最旧开始丢
 * - 至少保留最近一轮（即使其自身超预算，也不发送空历史）
 */
export function trimHistory(messages: LLMMessage[], maxTokens: number): LLMMessage[] {
  // 头部：system + 初始 user（第一个 assistant 之前的连续前缀）
  let headEnd = 0;
  while (headEnd < messages.length && messages[headEnd]!.role !== 'assistant') {
    headEnd++;
  }
  const head = messages.slice(0, headEnd);

  // 轮组划分：rest 中每个 assistant 开启一个新轮组，其后 tool 消息归属之
  const turns: LLMMessage[][] = [];
  for (const message of messages.slice(headEnd)) {
    if (message.role === 'assistant' || turns.length === 0) {
      turns.push([message]);
    } else {
      turns[turns.length - 1]!.push(message);
    }
  }
  if (turns.length === 0) return messages;

  // 从最新往旧收集，预算内尽量多保留；最近一轮无条件保留
  const kept: LLMMessage[][] = [];
  let total = head.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  for (let i = turns.length - 1; i >= 0; i--) {
    const turnTokens = turns[i]!.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    if (kept.length > 0 && total + turnTokens > maxTokens) break;
    kept.unshift(turns[i]!);
    total += turnTokens;
  }

  return [...head, ...kept.flat()];
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
 * sub-agent tool 命名约定:`agent.<agentName>`（见 [agentRegistry.asTool](../../faapi/src/injection/agentRegistry.md)）。
 * 非 `agent.` 前缀的原样返回（用于业务方自定义 sub-agent tool 命名）。
 */
function extractSubAgentName(toolName: string): string {
  const prefix = 'agent.';
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
    // 历史裁剪（maxHistoryTokens）：只作用于发给 LLM 的消息副本，本地 messages 不变
    const outgoing = config.maxHistoryTokens
      ? trimHistory(messages, config.maxHistoryTokens)
      : messages;
    // 浅拷贝快照:该轮发给 LLM 的输入消息（数组新对象,消息对象引用共享）
    const inputSnapshot = enableTracing ? [...outgoing] : undefined;
    // 执行中取消由 provider 请求中断传播——附上断点历史重抛（不含未完成的 assistant 消息，
    // 轮组原子性见 reactLoop.md 中断恢复章节）
    let response: LLMResponse;
    try {
      response = await config.provider.complete({
        messages: [...outgoing],
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
    // 历史裁剪（maxHistoryTokens）：只作用于发给 LLM 的消息副本，本地 messages 不变
    const outgoing = config.maxHistoryTokens
      ? trimHistory(messages, config.maxHistoryTokens)
      : messages;
    // 浅拷贝快照:该轮发给 LLM 的输入消息（数组新对象,消息对象引用共享）
    const inputSnapshot = enableTracing ? [...outgoing] : undefined;
    let turnContent = '';
    let turnReasoning = '';
    let toolCalls: LLMToolCall[] | undefined;
    let finishReason: LLMStopReason | undefined;
    let turnUsage: LLMUsage | undefined;

    // 执行中取消由 provider 流中断传播——附上断点历史重抛。当前轮已 yield 的部分
    // deltaContent 属于未完成轮组，不入历史（轮组原子性见 reactLoop.md 中断恢复章节）
    try {
      for await (const chunk of config.provider.stream({
        messages: [...outgoing],
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
          totalUsage = accumulateUsage(totalUsage, chunk.usage);
          turnUsage = chunk.usage;
        }
      }
    } catch (err) {
      if (err instanceof AgentAbortError) {
        throw new AgentAbortError(err.message, messages);
      }
      throw err;
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
      const donePayload: NonNullable<ReactLoopStreamChunk['done']> = {
        content: turnContent,
        turns: loopTurns + subTurns,
        stopReason: finishReason ?? 'other',
        usage: totalUsage,
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
      try {
        args = parseToolCallArguments(toolCall);
        yield { toolCall: { name: toolName, arguments: args } };
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
