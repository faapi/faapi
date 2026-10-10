import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 执行作用域上下文（详见 [agentScope.md](./agentScope.md)）
 *
 * run/stream 全链上让业务任何深层（tool 内部的 DAO、审计层、成本分摊层）能读到
 * 「当前跑在哪个 agent、第几层」。ALS 实现，纯读取上下文——不改任何执行语义，
 * 不读 = 零行为变化；作用域由框架在结构正确的位置（Agent.run/stream 入口 +
 * sub 派发边界）自动维护，业务只读。
 */

/** 当前执行作用域 */
export interface AgentScope {
  /** 当前正在执行的 agent 注册名（根为 run 的 agent，派发中为 sub） */
  agentName: string;
  /** 递归深度，1 = 根 agent */
  depth: number;
}

const agentScopeStorage = new AsyncLocalStorage<AgentScope>();

/**
 * 读取当前执行作用域
 *
 * 非 agent 执行链上（health-check/cron/普通 API、直调 reactLoop）返回 undefined
 * ——业务侧自行静默跳过（不读 = 零开销，非 agent 链零 ALS 参与）。
 */
export function getAgentScope(): AgentScope | undefined {
  return agentScopeStorage.getStore();
}

/**
 * 在指定作用域内执行（框架内部挂载点，不对外导出——作用域由框架自动维护）
 *
 * Agent.run/stream 入口建 store；async generator 体内不捕获创建时上下文
 * （体内段落随消费方每次 next() 的上下文执行），流式路径因此逐次在作用域内
 * 驱动内层迭代器——详见 agentScope.md「实现要点」。
 */
export function runWithAgentScope<T>(scope: AgentScope, fn: () => T): T {
  return agentScopeStorage.run(scope, fn);
}
