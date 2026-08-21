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

export interface AgentHandle {
  /**
   * 非流式执行 agent
   *
   * 组装 ReAct 循环 config（systemPrompt + tools + maxTurns）→ 调
   * [reactLoop](./reactLoop.md) → 返回最终结果。
   *
   * @param input 用户输入文本
   * @returns 循环结果（content + messages + turns + stopReason + usage）
   * @throws {AgentError} agent 未注册
   * @throws {ReactLoopError} 超出 maxTurns
   * @throws {Error} LLM provider 抛错时立即传播
   */
  run(input: string): Promise<ReactLoopResult>;

  /**
   * 流式执行 agent
   *
   * 组装 config → 调 [reactLoopStream](./reactLoop.md) → yield 流式 chunk。
   * 适用于 LLM token 流式输出、tool 调用过程展示等场景。
   *
   * @param input 用户输入文本
   * @yields 流式 chunk（deltaContent / toolCall / toolResult / done）
   * @throws {AgentError} agent 未注册
   * @throws {ReactLoopError} 超出 maxTurns
   * @throws {Error} LLM provider 抛错时立即传播
   */
  stream(input: string): AsyncIterable<ReactLoopStreamChunk>;

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
