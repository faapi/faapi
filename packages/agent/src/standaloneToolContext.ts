/**
 * createStandaloneToolContext——无 app 编排场景的合规 AgentToolContext 构造助手
 *
 * `AgentDeps.ctx` 必填（AgentToolContext 契约）后，测试直调 / 编程式脚本 /
 * 插件 setup baseDeps 占位没有 app 可依赖，本助手提供诚实缺省：tasks 为
 * 抛错桩（调用即失败并给修复指引，绝不假成功）、log 走框架缺省 console
 * 出口、signal 为永不触发的 AbortSignal；overrides 浅合并注入契约字段与
 * 业务增强字段。
 *
 * 详见 [standaloneToolContext.md](./standaloneToolContext.md)。
 */

import { createLogger, createThrowingTaskClient, type AgentToolContext } from '@faapi/faapi';

/** createStandaloneToolContext 入参——契约字段覆盖 + 业务增强字段 */
export type StandaloneToolContextOverrides = Partial<AgentToolContext> & Record<string, unknown>;

/**
 * 构造合规 AgentToolContext（测试/编程式/占位场景）
 *
 * @param overrides 浅合并到缺省之上——契约字段（tasks/log/signal）按需替换，
 *   业务增强字段（currentUserId 等）直接落 ctx 顶层
 */
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
