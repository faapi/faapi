/**
 * createStandaloneToolContext——无 app 编排场景的合规 AgentToolContext 构造助手
 *
 * `AgentDeps.ctx` 必填（框架注入字段）后，测试直调 / 编程式脚本 /
 * 插件 setup baseDeps 占位没有 app 可依赖，本助手提供诚实缺省：tasks 为
 * 抛错桩（调用即失败并给修复指引，绝不假成功）、log 走框架缺省 console
 * 出口、signal 为永不触发的 AbortSignal。
 *
 * 业务字段（currentUserId 等）经 overrides 注入并**流型到返回类型**（泛型 T）——
 * 构造漏传业务字段时返回裸契约，赋给声明了业务校验类型的 ctx 参数在调用点编译报错
 * （编译期辅助拦截；运行时强制在真实分发管线 executeToolCall 的 ctx 声明即校验，
 * 测试调用走 callTool——直调 handler 不是受支持场景，见主包 agentToolContext.md）。
 * overrides 浅合并注入契约字段与业务字段。
 *
 * 详见 [standaloneToolContext.md](./standaloneToolContext.md)。
 */

import { createLogger, createThrowingTaskClient, type AgentToolContext } from '@faapi/faapi';

/** createStandaloneToolContext 入参——契约字段覆盖 + 业务字段 */
export type StandaloneToolContextOverrides = Partial<AgentToolContext> & Record<string, unknown>;

/**
 * 构造合规 AgentToolContext（测试/编程式/占位场景）——带业务字段时流型
 *
 * @param overrides 浅合并到缺省之上——契约字段（tasks/log/signal）按需替换，
 *   业务字段（currentUserId 等）直接落 ctx 顶层并流型到返回类型
 */

/**
 * 重载形态（两个签名）的类型行为经过六个场景 tsc 实测（见 standaloneToolContext.md）：
 * - 带实参 → 泛型流型（传业务字段流出 `AgentToolContext & T`，缺字段在消费点结构检查报错）
 * - 无实参 → 精确裸契约（泛型默认值 `Record<string, never>` 的索引签名会让缺字段
 *   检查穿透——never 对任何目标属性类型可赋，故无参路径必须走非泛型精确返回）
 */
export function createStandaloneToolContext<T extends Record<string, unknown>>(
  overrides: StandaloneToolContextOverrides & T,
): AgentToolContext & T;
export function createStandaloneToolContext(
  overrides?: Partial<AgentToolContext>,
): AgentToolContext;
export function createStandaloneToolContext(
  overrides: StandaloneToolContextOverrides = {},
): AgentToolContext {
  const { tasks, log, signal, ...rest } = overrides;
  return {
    // tasks 缺省为抛错桩（主包同源实现——无队列场景用即显式失败，不假成功）
    tasks: tasks ?? createThrowingTaskClient(),
    log: log ?? createLogger('standalone'),
    signal: signal ?? new AbortController().signal,
    ...rest,
  } as AgentToolContext;
}
