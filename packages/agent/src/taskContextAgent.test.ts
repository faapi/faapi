import { describe, it, expect } from 'vitest';
import type { TaskContext } from '@faapi/faapi';
import type { AgentHandle } from './agentHandle';
import './taskContextAgent';

/**
 * TaskContext.agent 类型增强（declare module 声明合并）的编译级锁定：
 * 业务 import '@faapi/agent' 后 taskCtx.agent 即为 AgentHandle | undefined
 * 强类型——运行时行为（惰性构造/隔离 undefined）由主包 taskQueue.test 覆盖，
 * 这里只锁类型合并生效（编译通过即绿）。
 */
type AssertAssignable<T, U extends T> = U;
// TaskContext['agent'] 必须可赋值给 AgentHandle | undefined（增强生效的充要形态）
type _AgentFieldIsAugmented = AssertAssignable<AgentHandle | undefined, TaskContext['agent']>;

describe('TaskContext.agent 类型增强', () => {
  it('declare module 声明合并生效（编译通过即绿）', () => {
    const ctx = { carry: {} } as unknown as TaskContext;
    const agent: AgentHandle | undefined = ctx.agent;
    expect(agent).toBeUndefined();
  });
});
