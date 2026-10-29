/**
 * createTaskToolContext——任务路径的 AgentToolContext 合成（单一配方）
 *
 * 进程内任务的 `taskCtx.agent` 惰性通道与隔离任务的宿主侧工具执行器共用：
 * carry 数据字段落顶层（身份在 enqueue 处声明一次），契约字段（tasks/log/
 * signal）后置展开——carry 不可覆盖框架保证。
 *
 * 合成规则与消费点见 [taskToolContext.md](./taskToolContext.md)；
 * 契约定义见 [../runtime/agentToolContext.md](../runtime/agentToolContext.md)。
 */

import type { Logger } from '../loggers/loggerTypes';
import type { AgentToolContext } from '../runtime/agentToolContext';

/** 合成入参——任务执行现场的 carry 快照与任务级能力 */
export interface TaskToolContextSource {
  /** enqueue 时 `opts.carry` 声明的执行上下文快照（未携带为空对象） */
  carry: Record<string, unknown>;
  /** 任务执行作用域的 TaskClient（进程内 scoped / 隔离宿主侧 scoped） */
  tasks: AgentToolContext['tasks'];
  /** 任务级 logger（scope `task:<name>`，jobId/task/attempt） */
  log: Logger;
  /** 任务取消信号（停机取消——驱动 signal abort） */
  signal: AbortSignal;
}

/** 按「carry 展开 + 契约字段后置」配方合成契约 ctx */
export function createTaskToolContext(source: TaskToolContextSource): AgentToolContext {
  return {
    ...source.carry,
    tasks: source.tasks,
    log: source.log,
    signal: source.signal,
  } as AgentToolContext;
}
