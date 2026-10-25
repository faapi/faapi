import { describe, it, expect } from 'vitest';
import type { IsolatedTaskContext, TaskContext } from '@faapi/faapi';
import type { AgentHandle } from './agentHandle';
import type { AgentRpcHandle } from './taskContextAgent';
import './taskContextAgent';

/**
 * TaskContext.agent / IsolatedTaskContext.agent 类型增强（declare module 声明合并）
 * 的编译级锁定：业务 import '@faapi/agent' 后——
 * - 进程内任务 taskCtx.agent 即 AgentHandle | undefined 强类型（run/stream/asTool）
 * - 隔离任务 taskCtx.agent 即 AgentRpcHandle | undefined 强类型（run-only RPC 代理，
 *   编排循环收敛宿主）
 * 运行时行为由主包 taskQueue.test / taskWorker.test 覆盖，这里只锁类型合并生效
 * （编译通过即绿）。
 */
type AssertAssignable<T, U extends T> = U;
// TaskContext['agent'] 必须可赋值给 AgentHandle | undefined（增强生效的充要形态）
type _AgentFieldIsAugmented = AssertAssignable<AgentHandle | undefined, TaskContext['agent']>;
// IsolatedTaskContext['agent'] 必须可赋值给 AgentRpcHandle | undefined（run-only 语义）
type _IsolatedAgentFieldIsAugmented = AssertAssignable<
  AgentRpcHandle | undefined,
  IsolatedTaskContext['agent']
>;

describe('TaskContext.agent 类型增强', () => {
  it('declare module 声明合并生效（编译通过即绿）', () => {
    const ctx = { carry: {} } as unknown as TaskContext;
    const agent: AgentHandle | undefined = ctx.agent;
    expect(agent).toBeUndefined();
  });

  it('IsolatedTaskContext.agent 增强为 AgentRpcHandle（run-only，无 stream/asTool）', () => {
    const ctx = { carry: {} } as unknown as IsolatedTaskContext;
    const agent: AgentRpcHandle | undefined = ctx.agent;
    expect(agent).toBeUndefined();
  });
});
