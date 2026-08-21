import type {
  LLMMessage,
  LLMProvider,
  LLMStopReason,
  LLMToolCall,
  LLMToolDefinition,
  LLMUsage,
} from './provider';

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
 * - agent-as-tool（`agent.` 前缀）→ 递归调子 agent 的 reactLoop（含 `maxAgentDepth` 防护）
 *
 * 返回值可以是任意类型——非 string 会被 JSON.stringify 后回传 LLM。
 */
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

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
}

/**
 * 非流式循环结果
 */
export interface ReactLoopResult {
  /** 最终 assistant 消息内容 */
  content: string;
  /** 完整对话历史（system + user + assistant + tool 消息） */
  messages: LLMMessage[];
  /** 使用的轮数（含最终轮） */
  turns: number;
  /** 最终轮的停止原因 */
  stopReason: LLMStopReason;
  /** 累计 token 用量（多轮累加，provider 不返回时为 `undefined`） */
  usage?: LLMUsage;
}

/**
 * 流式循环的单个 chunk
 *
 * 每个 chunk 至多含一个字段：
 * - `deltaContent` — LLM 增量 token（多次 yield）
 * - `toolCall` — tool 开始执行
 * - `toolResult` — tool 执行完成
 * - `done` — 循环结束（只 yield 一次）
 */
export interface ReactLoopStreamChunk {
  /** LLM 增量 token */
  deltaContent?: string;
  /** tool 开始执行（LLM 请求调用 tool） */
  toolCall?: { name: string; arguments: Record<string, unknown> };
  /** tool 执行完成（含结果） */
  toolResult?: { name: string; result: string };
  /** 循环结束 */
  done?: {
    content: string;
    turns: number;
    stopReason: LLMStopReason;
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

  constructor(message: string, maxTurns: number) {
    super(message);
    this.name = 'ReactLoopError';
    this.maxTurns = maxTurns;
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

/** 累加 usage */
function accumulateUsage(a: LLMUsage | undefined, b: LLMUsage): LLMUsage {
  if (!a) return { ...b };
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
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

/** 构造 LLM complete/stream 请求参数（除 messages 外的公共字段） */
function buildRequestExtras(config: ReactLoopConfig) {
  return {
    tools: config.tools,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}

// ─── reactLoop（非流式）──────────────────────────────

/**
 * 执行 ReAct 循环（非流式）
 *
 * 反复调 `provider.complete()` → 执行 tool → 回传结果，直到 LLM 返回 `stop`（或其他非 `tool_calls` 原因）或超出 `maxTurns`。
 *
 * @param input 用户输入
 * @param config 循环配置
 * @returns 最终结果（content + messages + turns + stopReason + usage）
 * @throws {ReactLoopError} 超出 maxTurns
 * @throws {Error} provider.complete 抛错时立即传播
 */
export async function reactLoop(input: string, config: ReactLoopConfig): Promise<ReactLoopResult> {
  const messages = buildInitialMessages(input, config.systemPrompt);
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  const extras = buildRequestExtras(config);
  let totalUsage: LLMUsage | undefined;
  let turns = 0;

  while (turns < maxTurns) {
    turns++;

    const response = await config.provider.complete({
      messages: [...messages],
      ...extras,
    });

    if (response.usage) {
      totalUsage = accumulateUsage(totalUsage, response.usage);
    }

    // 把 assistant 消息加入历史
    messages.push(response.message);

    // 非 tool_calls → 循环结束
    if (response.stopReason !== 'tool_calls' || !response.message.toolCalls) {
      return {
        content: response.message.content,
        messages,
        turns,
        stopReason: response.stopReason,
        usage: totalUsage,
      };
    }

    // 执行每个 tool call
    for (const toolCall of response.message.toolCalls) {
      let resultStr: string;
      try {
        const result = await config.executeTool(toolCall.name, toolCall.arguments);
        resultStr = stringifyResult(result);
      } catch (err) {
        resultStr = stringifyError(err);
      }
      messages.push({
        role: 'tool',
        content: resultStr,
        toolCallId: toolCall.id,
      });
    }
  }

  throw new ReactLoopError(
    `Max turns (${maxTurns}) exceeded — agent did not converge to a final answer`,
    maxTurns,
  );
}

// ─── reactLoopStream（流式）──────────────────────────

/**
 * 执行 ReAct 循环（流式）
 *
 * 使用 `provider.stream()` 异步迭代 chunks，yield `deltaContent` + `toolCall` + `toolResult` + `done`。
 *
 * @param input 用户输入
 * @param config 循环配置
 * @yields {ReactLoopStreamChunk} 流式 chunk
 * @throws {ReactLoopError} 超出 maxTurns
 * @throws {Error} provider.stream 抛错时立即传播
 */
export async function* reactLoopStream(
  input: string,
  config: ReactLoopConfig,
): AsyncIterable<ReactLoopStreamChunk> {
  const messages = buildInitialMessages(input, config.systemPrompt);
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  const extras = buildRequestExtras(config);
  let totalUsage: LLMUsage | undefined;
  let turns = 0;

  while (turns < maxTurns) {
    turns++;

    let turnContent = '';
    let toolCalls: LLMToolCall[] | undefined;
    let finishReason: LLMStopReason | undefined;

    for await (const chunk of config.provider.stream({
      messages: [...messages],
      ...extras,
    })) {
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
      }
    }

    // 把 assistant 消息加入历史（含 toolCalls，供下一轮 LLM 上下文）
    const assistantMessage: LLMMessage = {
      role: 'assistant',
      content: turnContent,
    };
    if (toolCalls) {
      assistantMessage.toolCalls = toolCalls;
    }
    messages.push(assistantMessage);

    // 非 tool_calls → 循环结束
    if (finishReason !== 'tool_calls' || !toolCalls) {
      yield {
        done: {
          content: turnContent,
          turns,
          stopReason: finishReason ?? 'other',
          usage: totalUsage,
        },
      };
      return;
    }

    // 执行每个 tool call
    for (const toolCall of toolCalls) {
      yield { toolCall: { name: toolCall.name, arguments: toolCall.arguments } };

      let resultStr: string;
      try {
        const result = await config.executeTool(toolCall.name, toolCall.arguments);
        resultStr = stringifyResult(result);
      } catch (err) {
        resultStr = stringifyError(err);
      }

      yield { toolResult: { name: toolCall.name, result: resultStr } };

      messages.push({
        role: 'tool',
        content: resultStr,
        toolCallId: toolCall.id,
      });
    }
  }

  throw new ReactLoopError(
    `Max turns (${maxTurns}) exceeded — agent did not converge to a final answer`,
    maxTurns,
  );
}
