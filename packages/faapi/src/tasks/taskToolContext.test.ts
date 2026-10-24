import { describe, it, expect } from 'vitest';
import { createTaskToolContext } from './taskToolContext';
import type { AgentToolContext } from '../runtime/agentToolContext';

describe('createTaskToolContext', () => {
  it('carry 数据字段落顶层（身份在 enqueue 处声明一次）', () => {
    const tasks = { enqueue: async () => ({}) } as unknown as AgentToolContext['tasks'];
    const log = { info: () => {} } as unknown as AgentToolContext['log'];
    const signal = new AbortController().signal;

    const ctx = createTaskToolContext({
      carry: { currentUserId: 7, workspaceId: 'w1' },
      tasks,
      log,
      signal,
    });

    expect((ctx as AgentToolContext & { currentUserId?: number }).currentUserId).toBe(7);
    expect((ctx as AgentToolContext & { workspaceId?: string }).workspaceId).toBe('w1');
  });

  it('契约字段与源同引用', () => {
    const tasks = { enqueue: async () => ({}) } as unknown as AgentToolContext['tasks'];
    const log = { info: () => {} } as unknown as AgentToolContext['log'];
    const signal = new AbortController().signal;

    const ctx = createTaskToolContext({ carry: {}, tasks, log, signal });

    expect(ctx.tasks).toBe(tasks);
    expect(ctx.log).toBe(log);
    expect(ctx.signal).toBe(signal);
  });

  it('carry 不可覆盖契约字段（框架字段后置展开）', () => {
    const tasks = { enqueue: async () => ({}) } as unknown as AgentToolContext['tasks'];
    const log = { info: () => {} } as unknown as AgentToolContext['log'];
    const signal = new AbortController().signal;

    const ctx = createTaskToolContext({
      carry: { tasks: 'polluted', log: 'polluted', signal: 'polluted' },
      tasks,
      log,
      signal,
    });

    expect(ctx.tasks).toBe(tasks);
    expect(ctx.log).toBe(log);
    expect(ctx.signal).toBe(signal);
  });

  it('空 carry（cron 触发）合成为仅含契约字段的对象', () => {
    const tasks = { enqueue: async () => ({}) } as unknown as AgentToolContext['tasks'];
    const ctx = createTaskToolContext({
      carry: {},
      tasks,
      log: { info: () => {} } as unknown as AgentToolContext['log'],
      signal: new AbortController().signal,
    });

    expect(Object.keys(ctx).sort()).toEqual(['log', 'signal', 'tasks']);
  });
});
