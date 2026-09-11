import type { LlmConfig } from '@faapi/faapi';
import { createOpenAIProvider } from './providers/openai';

/**
 * LLM Provider 抽象层
 *
 * 统一 `complete` / `stream` 接口，屏蔽 OpenAI / Anthropic 等 LLM 服务差异。
 * [reactLoop](./reactLoop.md) 与 [Agent 类](./agent.md) 通过此接口调用 LLM，
 * 与具体 provider 解耦。
 *
 * 详见 [provider.md](./provider.md)。
 */

/**
 * 对话消息（OpenAI chat completions 规范形）
 *
 * 四种 role 与 OpenAI chat completions 一致：
 * - `system` —— 系统提示词（agent 的 systemPrompt）
 * - `user` —— 用户输入
 * - `assistant` —— LLM 回复（可能含 tool_calls）
 * - `tool` —— tool 执行结果（需带 tool_call_id 标识对应哪个 tool_call）
 *
 * 字段拼写与 OpenAI 线格式一致（`tool_calls` / `tool_call_id`），OpenAI provider
 * 对 messages 恒等透传，观测/存储/展示消费方按 OpenAI 形状处理即可。
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** 消息内容（assistant 角色 + tool_calls 时可能为空字符串） */
  content: string;
  /** role='tool' 时:对应的 tool_call ID（用于 LLM 关联 tool 结果） */
  tool_call_id?: string;
  /** role='assistant' 时:LLM 请求的 tool 调用（reactLoop 据此执行 tool） */
  tool_calls?: LLMToolCall[];
  /**
   * role='assistant' 时:thinking 模型的推理内容（DeepSeek 线格式字段名）
   *
   * provider 响应解析产物（非流式含完整内容），供业务方展示/审计；
   * **不回传 LLM API**——OpenAI provider 发送请求时剥离（DeepSeek 多轮回传
   * 推理内容直接 400，OpenAI 等拒绝未知字段），reactLoop 组装历史时同样剥离。
   * 兼容解析：线格式 `reasoning_content` 优先，缺失时读 `reasoning`（OpenRouter 形状）。
   */
  reasoning_content?: string;
}

/**
 * assistant 消息内的 tool 调用（OpenAI chat completions 规范形）
 *
 * 由 LLM 在 assistant 消息中返回。`function.arguments` 是线格式的 JSON **字符串**
 * （不预解析）——消息历史可原样透传与持久化；[reactLoop](./reactLoop.md) 在执行前
 * JSON.parse，tool 执行函数 / 鉴权钩子 / trace 事件拿到的都是已 parse 的对象。
 */
export interface LLMToolCall {
  /** tool call ID（provider 分配，用于匹配 tool 结果） */
  id: string;
  /** 固定 `'function'`（OpenAI 线格式） */
  type: 'function';
  function: {
    /** tool 名（匹配 LLMToolDefinition.function.name） */
    name: string;
    /** tool 参数（JSON 字符串，线格式原样） */
    arguments: string;
  };
}

/**
 * Tool 定义（OpenAI chat completions 规范形）
 *
 * 由 [reactLoop](./reactLoop.md) 从 [toolRegistry](../../faapi/src/injection/toolRegistry.md)
 * + [agentRegistry.resolveSubAgents](../../faapi/src/injection/agentRegistry.md) 组装：
 * - 常规 tool：`function.parameters` 来自 AST 提取的 zod schema（JSON Schema 形式）
 * - agent-as-tool：`function.parameters` 为自由 schema（agent 参数开放）
 */
export interface LLMToolDefinition {
  /** 固定 `'function'`（OpenAI 线格式） */
  type: 'function';
  function: {
    /** tool 名（如 `weather.getWeather` 或 `agent.researcher`） */
    name: string;
    /** tool 描述（对 LLM 可见，引导 LLM 选择调用） */
    description?: string;
    /** JSON Schema 对象（描述 tool 参数结构） */
    parameters?: Record<string, unknown>;
  };
}

/**
 * complete / stream 的入参
 *
 * `model` / `temperature` / `maxTokens` 优先级高于 [LlmConfig](../../faapi/src/config/configTypes.md)
 * （agent 自身 `config.model` 覆盖全局默认）。
 */
export interface LLMCompleteRequest {
  /** 对话消息（含历史 + 当前轮） */
  messages: LLMMessage[];
  /** 可用 tool 列表（未提供时 LLM 不会发起 tool_call） */
  tools?: LLMToolDefinition[];
  /** 覆盖 LlmConfig.model（agent 自身配置优先） */
  model?: string;
  /** 采样温度（0~2） */
  temperature?: number;
  /** 最大生成 token 数 */
  maxTokens?: number;
  /**
   * 取消信号（透传到底层 HTTP 请求）
   *
   * abort 时请求中断并抛 `AgentAbortError`；与 `LlmConfig.timeoutMs` 的
   * 超时信号组合生效（任一触发即中断）。
   */
  signal?: AbortSignal;
}

/**
 * Agent 执行被取消
 *
 * 外部 `AbortSignal` 触发时抛出（请求前预检查或请求中断）。
 * 业务方通过 `instanceof AgentAbortError` 区分「用户取消」与真实错误——
 * 取消不是故障，不应触发告警/重试逻辑。
 *
 * `messages` 为中断时刻的部分对话历史（截至最后一个完整轮组），由
 * [reactLoop](./reactLoop.md) 在循环边界附加（provider 层不感知历史，恒为空数组）。
 * 业务方持久化后经 `config.messages` / `AgentRunOptions.messages` 从断点续跑，
 * 语义详见 [reactLoop.md](./reactLoop.md) 中断恢复章节。
 */
export class AgentAbortError extends Error {
  /** 中断时刻的部分对话历史（完整轮组快照，可直接用于续跑） */
  readonly messages: LLMMessage[];

  constructor(message = 'Agent execution aborted', messages: LLMMessage[] = []) {
    super(message);
    this.name = 'AgentAbortError';
    this.messages = messages;
  }
}

/**
 * LLM 响应的停止原因
 *
 * - `stop` —— LLM 主动结束（自然结束 / 遇到 stop 序列）
 * - `tool_calls` —— LLM 请求调用 tool（reactLoop 据此进入下一轮）
 * - `length` —— 达到 max_tokens 上限
 * - `content_filter` —— 内容过滤触发
 * - `other` —— 其他原因（未识别的 finish_reason）
 */
export type LLMStopReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';

/**
 * complete 的返回
 *
 * `message.tool_calls` 不为空时 stopReason 应为 `'tool_calls'`。
 */
export interface LLMResponse {
  /** assistant 消息（OpenAI 规范形，含 content + 可选 tool_calls） */
  message: LLMMessage;
  /** 停止原因（reactLoop 据此判断是否进入下一轮） */
  stopReason: LLMStopReason;
  /** token 用量（部分 provider 不返回） */
  usage?: LLMUsage;
}

/**
 * Token 用量（OpenAI chat completions 规范形）
 */
export interface LLMUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * stream 的单个 chunk
 *
 * provider 内部流抽象（非 OpenAI 分片 delta 线格式）：
 * - 内容流：`deltaContent` 为增量 token
 * - 推理内容流（thinking 模型）：`deltaReasoning` 为推理增量（与 `deltaContent` 同为
 *   增量语义，消费方按到达顺序各自拼接）
 * - tool 调用：累积完成后在最终 chunk 一并 emit `toolCalls`（OpenAI 规范形，
 *   `function.arguments` 为 JSON 字符串）
 * - 结束：最终 chunk 含 `finishReason` + 可选 `usage`
 */
export interface LLMStreamChunk {
  /** 增量内容（streaming token） */
  deltaContent?: string;
  /** 推理内容增量（thinking 模型，如 DeepSeek `reasoning_content` / OpenRouter `reasoning`） */
  deltaReasoning?: string;
  /** 累积完成的 tool 调用（在最终 chunk 出现） */
  toolCalls?: LLMToolCall[];
  /** 结束原因（只在最终 chunk 出现） */
  finishReason?: LLMStopReason;
  /** token 用量（部分 provider 在最终 chunk 提供） */
  usage?: LLMUsage;
}

/**
 * LLM Provider 抽象接口
 *
 * 实现方：
 * - [createOpenAIProvider](./providers/openai.md) —— OpenAI 兼容 API
 *
 * 消费方：
 * - [reactLoop](./reactLoop.md) Phase 3.3 —— 调 complete / stream 执行 ReAct 循环
 * - [Agent 类](./agent.md) Phase 3.4 —— 构造时持有 provider 实例
 */
export interface LLMProvider {
  /** 非流式:阻塞到 LLM 返回完整响应 */
  complete(request: LLMCompleteRequest): Promise<LLMResponse>;
  /** 流式:异步迭代 chunk(增量 token + tool call + 结束) */
  stream(request: LLMCompleteRequest): AsyncIterable<LLMStreamChunk>;
}

/**
 * LLM Provider 错误
 *
 * 由具体 provider 抛出,包含 HTTP 状态码（网络错误为 `undefined`）和响应体摘要。
 * 业务方可通过 `instanceof LLMProviderError` 区分 LLM 错误与其他错误。
 *
 * 重新从 [./providers/openai](./providers/openai.md) 导出,便于业务方从此模块统一捕获。
 */
export { LLMProviderError } from './providers/openai';

/**
 * 按 `config.provider` 路由到对应的 LLM 适配器
 *
 * Phase 3.2 仅支持 `'openai'`,其他值抛错不静默降级（参考 AGENTS.md §6.3）。
 *
 * @param config LLM 提供方配置（来自 faapi.config.ts 的 `agent.llms[key]`）
 * @returns LLMProvider 实例
 * @throws {Error} 当 `config.provider` 不是已支持的值
 */
export function createProvider(config: LlmConfig): LLMProvider {
  switch (config.provider) {
    case 'openai':
      return createOpenAIProvider(config);
    default:
      throw new Error(`Unsupported LLM provider: ${String(config.provider)}`);
  }
}
