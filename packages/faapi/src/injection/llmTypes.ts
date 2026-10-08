/**
 * 轻量 LLM 补全通道规范类型
 *
 * `LlmComplete` / `LlmCompleteOptions` 是轻量补全通道（`@faapi/agent` 的
 * `createLightComplete` 实现）的接口契约，规范类型由主包持有——`TaskContext.llm` /
 * `TaskQueueDeps` / `LlmChannelStore` 等主包类型需引用，而主包不能反向依赖
 * `@faapi/agent`（依赖方向 agent → 主包 peer）。`@faapi/agent` 实现并 re-export，
 * 业务方统一从 `@faapi/agent` 导入标注。
 *
 * `onFailure` 的 error 参数在此层是 `Error`——具体错误类（`LLMProviderError` /
 * `LLMTimeoutError`）由实现层抛出，业务方 `instanceof` 细分时从 `@faapi/agent`
 * 导入类做窄化。
 *
 * 详见 [llmTypes.md](./llmTypes.md) 与 `@faapi/agent` 的 lightComplete.md。
 */

/** 轻量补全的调用级选项——传输策略（重试/超时/降级/留痕）按场景声明 */
export interface LlmCompleteOptions {
  /**
   * 模型字符串 key（与 `agent.run` 的 `options.model` 同一解析规则）：
   * llms key（如 `'openai'`）/ `provider/model` 一体化（如 `'openai/gpt-4o'`）/
   * 纯 model 名（在所有 provider 的 `models` 里查找，唯一时命中）
   *
   * 缺省回落 `agent.llms` 第一个 provider 的第一个 model。
   */
  model?: string;
  /** 可选 system 提示词（前置为 system 消息） */
  system?: string;
  /** 采样温度（0~2） */
  temperature?: number;
  /** 最大生成 token 数 */
  maxTokens?: number;
  /**
   * 取消信号（透传到底层 HTTP 请求）
   *
   * abort 时抛 `AgentAbortError`——取消不是故障：不走 fallback、不触发 onFailure。
   */
  signal?: AbortSignal;
  /**
   * 本次调用超时（毫秒）
   *
   * 优先级：本字段 > 目标 provider 的 `LlmConfig.timeoutMs` > 框架默认 60s。
   * 超时抛 `LLMTimeoutError`（计入重试，与 429/5xx/网络错误同策略）。
   */
  timeoutMs?: number;
  /**
   * 本次调用重试上限（429/5xx/网络错误/超时计入重试）
   *
   * 缺省回落 `LlmConfig.maxRetries`（默认 2，0 关闭）。
   */
  maxRetries?: number;
  /**
   * 降级值：传输失败（重试耗尽）时返回本值而不抛
   *
   * 「LLM 失败可降级不可静默」——fallback 命中且未声明 `onFailure` 时，
   * 框架 `console.warn` 兜底留痕（错误消息含尝试次数）。
   * 未声明时失败原样抛 `LLMProviderError`。
   */
  fallback?: string;
  /**
   * 失败钩子：重试耗尽后触发（留痕/告警/台账等副作用；自身抛错被忽略）
   *
   * - `error` 为 `LLMProviderError`（`instanceof LLMTimeoutError` 细分超时，
   *   `error.status` 区分 HTTP 状态——502/504 分型等）
   * - `info.attempts` 为实际发起的 HTTP 尝试次数（含失败尝试，≥1）
   *
   * 声明本钩子后框架不再重复 `console.warn`（钩子即留痕点）。
   * 用户取消（`AgentAbortError`）不触发本钩子。
   */
  onFailure?: (error: Error, info: { attempts: number }) => void;
}

/**
 * 轻量补全通道（handler `llm` 注入参数 / `taskCtx.llm` 的类型）
 *
 * 由 `@faapi/agent` 插件注册到 `registries.llm`（插件未加载时注入 `undefined`）。
 * 与 agent 循环共享 `agent.llms` 同源 providers，项目零新增配置。
 */
export interface LlmComplete {
  /**
   * 一次性补全：字符串进字符串出
   *
   * @returns assistant 消息 content（恒字符串；轻量通道不发 tools，LLM 不会请求 tool_call）
   * @throws {AgentError} model key 解析失败 / llms 未配置（编程/配置错误，不重试不降级）
   * @throws {LLMProviderError} 传输失败（重试耗尽）且未声明 `fallback`
   * @throws {AgentAbortError} 用户取消（`options.signal` 触发）
   */
  complete(input: string, options?: LlmCompleteOptions): Promise<string>;
}
