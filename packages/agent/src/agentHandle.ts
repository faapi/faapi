import type { AgentToolDescriptor, LlmConfig } from '@faapi/faapi';
import type { LLMMessage, LLMProvider } from './provider';
import type { ReactLoopResult, ReactLoopStreamChunk } from './reactLoop';

/**
 * agent handle——注入到 handler 的 `agent` 参数,提供可调用的 agent 运行入口
 *
 * faapi 核心的 [agentHandle](../../faapi/src/injection/agentHandle.md) 工厂注册机制
 * 让本包的 [plugin](./plugin.md) 在 setup 时注册工厂函数,injectParams 在
 * `agent` 参数注入时调工厂拿到 `AgentHandle` 实例。
 *
 * `Agent` 类满足此接口（结构化类型）,plugin 的工厂直接返回 `Agent` 实例,
 * 无需额外包装层。handler 通过 `AgentHandle` 类型获得类型安全:
 *
 * ```ts
 * import type { AgentHandle } from '@faapi/agent';
 *
 * // src/api/chat/handler.ts
 * export function POST(agent: AgentHandle, body: { input: string }) {
 *   const result = await agent.run(body.input);
 *   return { content: result.content, turns: result.turns };
 * }
 * ```
 *
 * 工厂未注册（`@faapi/agent` 插件未加载或 `config.agent.llm` / `defaultAgent` 未配置）
 * 时注入 `undefined`,handler 需自行处理。
 *
 * 详见 [agentHandle.md](./agentHandle.md)。
 */

/**
 * `agent.run` / `agent.stream` 的 options 参数——临时覆盖本次调用的 LLM 配置
 *
 * 所有字段可选,不传或 `undefined` 时回落到下一优先级（agent 元数据 → 全局配置）。
 * **不修改 agent 自身状态**——下一次调用仍用默认配置。
 *
 * `model` 是字符串 key,支持三种形式（解析规则见 [agentHandle.md](./agentHandle.md) 的
 * 「`options.model` 字符串 key 解析规则」）：
 * - llms 的 key 精确匹配（如 `'openai'`）
 * - `provider/model` 一体化（如 `'openai/gpt-4o'`）
 * - 纯 model 名（如 `'gpt-4o'`）—— 在所有 provider 的 `models` 里查找,唯一时切到对应 provider
 *
 * 优先级（高 → 低）：`options` > agent 元数据（`config.model` / `config.maxTurns`）> 全局
 * `AgentRuntimeConfig` / `defaultLlm` provider。详见 [agentHandle.md](./agentHandle.md) 的
 * Run-level 覆盖优先级表。
 *
 * `agent` 字段覆盖本次调用的 agent 名（不传时用 `config.agent.defaultAgent`，
 * 未设 defaultAgent 时必须显式传入）。
 *
 * @example
 * ```ts
 * // 按请求切模型（纯 model 名,在 llms 里唯一时切到对应 provider）
 * await agent.run(input, { model: 'gpt-4o-mini' });
 *
 * // provider/model 一体化形式（精确切换）
 * await agent.run(input, { model: 'anthropic/claude-3-5-sonnet' });
 *
 * // 指定 agent（不依赖 defaultAgent 配置）
 * await agent.run(input, { agent: 'researcher' });
 * ```
 */
export interface AgentRunOptions {
  /**
   * 取消信号（透传到每轮 LLM 请求）
   *
   * abort 后当前轮请求中断并抛 `AgentAbortError`，循环不再进入下一轮。
   * 业务方（如 SSE/WS 客户端断开）可通过 `req.signal` 等接入取消链路。
   */
  signal?: AbortSignal;
  /**
   * 覆盖本次调用的 agent 名（从 agentRegistry 查找对应元数据 / tools / sub-agents）
   *
   * 不传时用 `config.agent.defaultAgent`。`defaultAgent` 未设时必须显式传入，
   * 否则抛 `AgentError`。
   */
  agent?: string;
  /**
   * 切换 provider + model 的字符串 key（支持 llms key / `provider/model` / 纯 model 名）
   *
   * 不传时用 `defaultLlm` provider + agent 元数据 `config.model`。
   * `provider` 字段存在时本字段变为「原始 model 名」原样透传给外部 provider
   * （不做 llms key 解析,支持带 / 的 model id），详见 {@link AgentRunOptions.provider}。
   */
  model?: string;
  /**
   * 外部 provider（本次调用临时使用,优先级最高——完全不查 `config.agent.llms`）
   *
   * 两种形式（运行时按形状判别,两者皆非抛 `AgentError`）：
   * - `LlmConfig` 对象（含字符串 `provider` 字段）→ 现场调 `createProvider` 创建适配器
   *   （浅拷贝 + `models` 兜底 `{}`,不改调用方对象）,适用于 BYOK（用户自带 apiKey）/
   *   按请求指定 baseURL 网关
   * - `LLMProvider` 实例（有 `complete` / `stream` 方法）→ 直接使用,适用于框架未内置
   *   适配器的 LLM 服务（内部自研模型网关等）
   *
   * 传入时 `options.model` 语义变为「原始 model 名」——不做 llms key 解析、不拆 `/`,
   * 原样透传给该 provider（支持 OpenRouter 等带 `/` 的 model id）。
   * LlmConfig 形式下 `options.model` 缺省时回落该 config 的 `models` 第一个 key,
   * 两者皆无抛 `AgentError`；LLMProvider 实例形式下可为 `undefined`（自定义 provider 自决）。
   *
   * 仅影响本次调用——不进 providers Map、不修改 agent 状态,**sub-agent 递归不继承**
   * （sub-agent 仍走默认解析链路）,下一次调用仍用默认配置。
   */
  provider?: LlmConfig | LLMProvider;
  /** 采样温度（透传给 LLM API,覆盖 provider/model 级 temperature） */
  temperature?: number;
  /** 最大生成 token 数（透传给 LLM API） */
  maxTokens?: number;
  /**
   * 启用 tracing（默认沿用全局 `config.agent.enableTracing`,全局默认 `false`——
   * opt-in,不开启零开销）。
   *
   * 开启时 `ReactLoopResult.trace` / `ReactLoopStreamChunk.traceEvent` 填充
   * 结构化调用明细,详见 [trace.md](./trace.md)。
   */
  enableTracing?: boolean;
  /**
   * 初始对话历史（续跑 / 多轮对话）
   *
   * 提供时以其为基础,agent 的 systemPrompt 缺失时自动补齐；`input` 非空时追加为
   * 新的 user 消息（多轮对话）,为空时纯续跑。续跑源：
   * - `AgentAbortError.messages` —— 中断断点（客户端断开 / 请求取消）
   * - `ReactLoopError.messages` —— maxTurns 超限（提高预算后续跑）
   * - 上次 `result.messages` —— 多轮对话拼接
   *
   * 历史经结构校验（assistant.toolCalls 与 tool 结果按 toolCallId 配对完整、
   * role 合法）,非法抛 `AgentError`,不发起 LLM 请求。
   * 语义详见 [reactLoop.md](./reactLoop.md) 中断恢复章节。
   */
  messages?: LLMMessage[];
}

export interface AgentHandle {
  /**
   * 非流式执行 agent
   *
   * 组装 ReAct 循环 config（systemPrompt + tools + maxTurns + 应用 `options` 覆盖）→ 调
   * [reactLoop](./reactLoop.md) → 返回最终结果。
   *
   * @param input 用户输入文本（可选——续跑场景不传新输入；input 与
   *              `options.messages` 都为空时抛 `AgentError`）
   * @param options 临时覆盖本次调用的 model（字符串 key）/ temperature / maxTokens /
   *                messages（不修改 agent 自身状态,详见 {@link AgentRunOptions}）
   * @returns 循环结果（content + messages + turns + stopReason + usage）
   * @throws {AgentError} agent 未注册；input 与 messages 都为空；续跑历史结构非法
   * @throws {ReactLoopError} 超出 maxTurns（`error.messages` 可续跑）
   * @throws {AgentAbortError} 中断（`error.messages` 为断点历史,可续跑）
   * @throws {Error} LLM provider 抛错时立即传播
   */
  run(input?: string, options?: AgentRunOptions): Promise<ReactLoopResult>;

  /**
   * 流式执行 agent
   *
   * 组装 config（应用 `options` 覆盖）→ 调 [reactLoopStream](./reactLoop.md) → yield 流式 chunk。
   * 适用于 LLM token 流式输出、tool 调用过程展示等场景。
   *
   * @param input 用户输入文本（可选——续跑场景不传新输入；input 与
   *              `options.messages` 都为空时抛 `AgentError`）
   * @param options 临时覆盖本次调用的 model（字符串 key）/ temperature / maxTokens /
   *                messages（不修改 agent 自身状态,详见 {@link AgentRunOptions}）
   * @yields 流式 chunk（deltaContent / toolCall / toolResult / done）
   * @throws {AgentError} agent 未注册；input 与 messages 都为空；续跑历史结构非法
   * @throws {ReactLoopError} 超出 maxTurns（`error.messages` 可续跑）
   * @throws {AgentAbortError} 中断（`error.messages` 为断点历史,可续跑）
   * @throws {Error} LLM provider 抛错时立即传播
   */
  stream(input?: string, options?: AgentRunOptions): AsyncIterable<ReactLoopStreamChunk>;

  /**
   * 把自身包装为 `AgentToolDescriptor` 供 LLM 当 tool 调用
   *
   * 用于 agent-as-tool 场景：父 agent 把子 agent 包装为 tool,
   * 加入 LLM 可见 tool 列表,LLM 调用时触发 sub-agent 递归执行。
   *
   * @returns `AgentToolDescriptor` 或 `undefined`（agent 未注册）
   */
  asTool(): AgentToolDescriptor | undefined;
}
