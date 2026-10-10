/**
 * Agent 系统级错误家族
 *
 * 独立模块的动机：reactLoop（历史压缩不变量守卫）需要抛 `AgentError`，而
 * reactLoop 与 agent.ts 互相依赖（agent.ts 组装并调 reactLoop）——错误类下沉
 * 此处解开循环依赖。所有类经 agent.ts re-export，`from './agent'` 导入路径不变。
 *
 * 详见 [agentErrors.md](./agentErrors.md)。
 */

/**
 * Agent 系统级错误
 *
 * agent 未注册等不可恢复错误时抛出（调用方负责捕获）。
 * sub-agent 递归超限用 {@link AgentRecursionError}。
 * 历史压缩策略输出违反不变量（[historyCompaction.md](./historyCompaction.md)）同抛此类型。
 */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

/** tool 执行超时（toolTimeoutMs）——被 reactLoop catch 后回传 LLM,不终止整个 run */
export class AgentToolTimeoutError extends AgentError {
  /** 超时的 tool 名 */
  readonly toolName: string;
  /** 配置的超时毫秒数 */
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = 'AgentToolTimeoutError';
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * sub-agent 递归超 `maxAgentDepth` 时抛出
 *
 * 被 [reactLoop](./reactLoop.md) catch 后错误消息回传 LLM，LLM 可据此调整策略。
 */
export class AgentRecursionError extends AgentError {
  /** 配置的 maxAgentDepth 值 */
  readonly maxDepth: number;
  /** 当前递归深度（超出 maxDepth） */
  readonly currentDepth: number;

  constructor(maxDepth: number, currentDepth: number) {
    super(
      `Agent recursion depth exceeded: current depth ${currentDepth} > maxAgentDepth ${maxDepth}`,
    );
    this.name = 'AgentRecursionError';
    this.maxDepth = maxDepth;
    this.currentDepth = currentDepth;
  }
}
