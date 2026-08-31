import type { AgentToolDescriptor } from '@faapi/faapi';
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
 * @example
 * ```ts
 * // 按请求切模型（纯 model 名,在 llms 里唯一时切到对应 provider）
 * await agent.run(input, { model: 'gpt-4o-mini' });
 *
 * // provider/model 一体化形式（精确切换）
 * await agent.run(input, { model: 'anthropic/claude-3-5-sonnet' });
 * ```
 */
export interface AgentRunOptions {
  /**
   * 切换 provider + model 的字符串 key（支持 llms key / `provider/model` / 纯 model 名）
   *
   * 不传时用 `defaultLlm` provider + agent 元数据 `config.model`。
   */
  model?: string;
  /** 采样温度（透传给 LLM API,覆盖 provider/model 级 temperature） */
  temperature?: number;
  /** 最大生成 token 数（透传给 LLM API） */
  maxTokens?: number;
  /**
   * 启用 tracing（默认沿用全局 `config.agent.enableTracing`,全局默认 `true`）。
   *
   * 开启时 `ReactLoopResult.trace` / `ReactLoopStreamChunk.traceEvent` 填充
   * 结构化调用明细,详见 [trace.md](./trace.md)。
   *
   * 业务方在生产主路径显式传 `false` 关闭以零开销运行。
   */
  enableTracing?: boolean;
}

export interface AgentHandle {
  /**
   * 非流式执行 agent
   *
   * 组装 ReAct 循环 config（systemPrompt + tools + maxTurns + 应用 `options` 覆盖）→ 调
   * [reactLoop](./reactLoop.md) → 返回最终结果。
   *
   * @param input 用户输入文本
   * @param options 临时覆盖本次调用的 model（字符串 key）/ temperature / maxTokens
   *                （不修改 agent 自身状态,详见 {@link AgentRunOptions}）
   * @returns 循环结果（content + messages + turns + stopReason + usage）
   * @throws {AgentError} agent 未注册
   * @throws {ReactLoopError} 超出 maxTurns
   * @throws {Error} LLM provider 抛错时立即传播
   */
  run(input: string, options?: AgentRunOptions): Promise<ReactLoopResult>;

  /**
   * 流式执行 agent
   *
   * 组装 config（应用 `options` 覆盖）→ 调 [reactLoopStream](./reactLoop.md) → yield 流式 chunk。
   * 适用于 LLM token 流式输出、tool 调用过程展示等场景。
   *
   * @param input 用户输入文本
   * @param options 临时覆盖本次调用的 model（字符串 key）/ temperature / maxTokens
   *                （不修改 agent 自身状态,详见 {@link AgentRunOptions}）
   * @yields 流式 chunk（deltaContent / toolCall / toolResult / done）
   * @throws {AgentError} agent 未注册
   * @throws {ReactLoopError} 超出 maxTurns
   * @throws {Error} LLM provider 抛错时立即传播
   */
  stream(input: string, options?: AgentRunOptions): AsyncIterable<ReactLoopStreamChunk>;

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
