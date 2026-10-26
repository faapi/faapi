/**
 * LLM 线格式消息规范类型
 *
 * 自 `@faapi/agent` 的 provider.ts 迁入主包（规范类型主包持有、agent re-export 的
 * 既有先例——见 [injection/llmTypes](../injection/llmTypes.md) / 本目录 llmMessageTypes.md）：
 * `agent:input` 事件载荷（appEventBus 的 `AgentInputEvent`）需要引用消息类型，
 * 而主包不能反向依赖 `@faapi/agent`（依赖方向是 agent → 主包 peer）。
 *
 * 字段拼写与 OpenAI 线格式一致（`tool_calls` / `tool_call_id`），OpenAI provider
 * 对 messages 恒等透传，观测/存储/展示消费方按 OpenAI 形状处理即可。
 */

/**
 * 对话消息（OpenAI chat completions 规范形）
 *
 * role 语义：
 * - `system` —— 系统提示词（agent 人格 / 纪律）
 * - `user` —— 用户输入
 * - `assistant` —— LLM 回复（可能含 tool_calls）
 * - `tool` —— tool 执行结果（需带 tool_call_id 标识对应哪个 tool_call）
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
 * （不预解析）——消息历史可原样透传与持久化；reactLoop 在执行前
 * JSON.parse，tool 执行函数 / 鉴权钩子 / trace 事件拿到的都是已 parse 的对象。
 */
export interface LLMToolCall {
  /** tool call ID（provider 分配，用于匹配 tool 结果） */
  id: string;
  /** 固定 `'function'`（OpenAI 线格式） */
  type: 'function';
  function: {
    /** tool 名 */
    name: string;
    /** tool 参数（JSON 字符串，线格式原样） */
    arguments: string;
  };
}

/**
 * Tool 定义（OpenAI chat completions 规范形）
 *
 * 由 reactLoop 从 toolRegistry + agentRegistry.resolveSubAgents 组装：
 * - 常规 tool：`function.parameters` 来自 AST 提取的 zod schema（JSON Schema 形式）
 * - agent-as-tool：`function.parameters` 为自由 schema（agent 参数开放）
 *
 * 自 `@faapi/agent` provider.ts 迁入（`agent:filter-tools` 事件载荷引用,同
 * LLMMessage 迁移先例——规范类型主包持有,agent re-export）。
 */
export interface LLMToolDefinition {
  /** 固定 `'function'`（OpenAI 线格式） */
  type: 'function';
  function: {
    /** tool 名（如 `weather_getWeather` 或 `agent-researcher`） */
    name: string;
    /** tool 描述（对 LLM 可见，引导 LLM 选择调用） */
    description?: string;
    /** JSON Schema 对象（描述 tool 参数结构） */
    parameters?: Record<string, unknown>;
  };
}
