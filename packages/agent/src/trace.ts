import type { LLMMessage, LLMStopReason, LLMUsage } from './provider';

/**
 * 单次 agent.run() / agent.stream() 的结构化调用明细
 *
 * 默认开启（`enableTracing` 默认 `true`）,业务方在生产主路径显式
 * `enableTracing: false` 关闭以零开销运行。详见 [trace.md](./trace.md)。
 */
export interface AgentTrace {
  /** agent 名 */
  agentName: string;
  /** 开始时间（performance.now() ms,相对进程启动,便于算相对耗时） */
  startedAt: number;
  /** 总耗时 ms（done 时填充,抛错时也填充） */
  durationMs?: number;
  /** 总轮数（与 ReactLoopResult.turns 一致） */
  turns: number;
  /** 累计 token 用量（与 ReactLoopResult.usage 一致） */
  usage?: LLMUsage;
  /** 最终停止原因（与 ReactLoopResult.stopReason 一致） */
  stopReason?: LLMStopReason;
  /** 最终 assistant 内容（与 ReactLoopResult.content 一致） */
  content?: string;
  /** agent 抛错时的错误消息（agent.run 抛错时填充） */
  error?: string;
  /** 按发生顺序的事件列表 */
  events: AgentTraceEvent[];
}

/**
 * trace 事件（discriminated union,按 `type` 区分）
 *
 * 一次 agent.run() 内的事件序列示例：
 *   llm_call(turn=1) → tool_call(turn=1) → llm_call(turn=2) → done
 *
 * sub-agent 调用作为 `subagent_call` 事件,内嵌 sub-trace（递归结构）。
 */
export type AgentTraceEvent = LlmCallEvent | ToolCallEvent | SubAgentCallEvent;

/**
 * LLM 调用事件——每轮调 provider.complete() / provider.stream() 触发一次
 */
export interface LlmCallEvent {
  type: 'llm_call';
  /** 第几轮（从 1 开始） */
  turn: number;
  startedAt: number;
  durationMs?: number;
  /** 该轮调用的 model 名 */
  model: string;
  /** 该轮发给 LLM 的输入消息快照（浅拷贝数组,消息对象引用共享） */
  inputMessages: LLMMessage[];
  /** 该轮 LLM 返回的 assistant 消息（含 toolCalls 若有） */
  response: LLMMessage;
  /** 该轮的停止原因 */
  stopReason: LLMStopReason;
  /** 该轮的 token 用量（provider 不返回时 undefined） */
  usage?: LLMUsage;
}

/**
 * 常规 tool 调用事件——executeTool 返回 unknown 时触发
 */
export interface ToolCallEvent {
  type: 'tool_call';
  turn: number;
  startedAt: number;
  durationMs?: number;
  /** LLM 分配的 tool_call_id（与 messages 里 tool 消息的 toolCallId 一致） */
  toolCallId: string;
  /** tool 名 */
  name: string;
  /** tool 参数（已 JSON.parse 的对象） */
  arguments: Record<string, unknown>;
  /** tool 执行结果（stringifyResult 后的字符串,与 messages 里 tool 消息一致） */
  result: string;
  /** tool 抛错时填充（result 为 stringifyError 后的字符串） */
  error?: string;
}

/**
 * sub-agent 调用事件——executeTool 返回 TracingToolResult 时触发
 *
 * sub-agent 的 trace 嵌入 `trace` 字段（递归结构）,业务方可还原完整调用树。
 */
export interface SubAgentCallEvent {
  type: 'subagent_call';
  turn: number;
  startedAt: number;
  durationMs?: number;
  toolCallId: string;
  /** 被调用的 sub-agent 名 */
  agentName: string;
  /** 喂给 sub-agent 的输入（args JSON.stringify 后） */
  input: string;
  /** sub-agent 自己的 trace（递归） */
  trace: AgentTrace;
  /** sub-agent 返回的最终内容（sub-trace.content 的副本,便于不展开 sub-trace 也能读到结果） */
  result?: string;
  /** sub-agent 抛错时填充 */
  error?: string;
}

/**
 * sub-agent 调用的特殊返回值——reactLoop 据此识别 sub-agent 调用并发出 subagent_call 事件
 *
 * [Agent.executeSubAgent](./agent.md) 在 `enableTracing=true` 时返回此类型;
 * `enableTracing=false` 时返回 `unknown`（与常规 tool 一致）。
 *
 * `__trace` 是标记字段,避免与普通对象返回值冲突。reactLoop 通过
 * `typeof result === 'object' && result !== null && result.__trace === true`
 * 判断是否为 TracingToolResult。
 */
export interface TracingToolResult {
  /** 标记字段（避免与普通对象返回值冲突） */
  __trace: true;
  /** sub-agent 返回的业务结果（stringifyResult 后会作为 tool 消息内容） */
  result: unknown;
  /** sub-agent 自己的 trace */
  trace: AgentTrace;
}

/**
 * 类型守卫：判断 ToolExecutor 返回值是否为 TracingToolResult
 *
 * reactLoop 用此函数区分 sub-agent 调用（发出 subagent_call 事件）
 * 与常规 tool 调用（发出 tool_call 事件）。
 */
export function isTracingToolResult(value: unknown): value is TracingToolResult {
  return (
    typeof value === 'object' && value !== null && (value as { __trace?: unknown }).__trace === true
  );
}
