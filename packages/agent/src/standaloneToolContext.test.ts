import { describe, it, expect } from 'vitest';
import { createLogger } from '@faapi/faapi';
import { createStandaloneToolContext } from './standaloneToolContext';
import { createAgentDeps } from './agentDeps';
import type { AgentToolContext } from '@faapi/faapi';

describe('createStandaloneToolContext', () => {
  it('缺省字段齐备：log 可调用、signal 未触发', () => {
    const ctx = createStandaloneToolContext();

    expect(typeof ctx.log.info).toBe('function');
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.signal.aborted).toBe(false);
  });

  it('tasks 缺省为抛错桩：任意方法调用显式抛错并含修复指引', () => {
    const ctx = createStandaloneToolContext();

    expect(() => (ctx.tasks as unknown as { enqueue: () => Promise<unknown> }).enqueue()).toThrow(
      /无任务队列/,
    );
    expect(() => (ctx.tasks as unknown as { enqueue: () => Promise<unknown> }).enqueue()).toThrow(
      /TaskClient 假体/,
    );
  });

  it('overrides 浅合并：契约字段可替换', () => {
    const signal = new AbortController().signal;
    const log = createLogger('test');
    const tasks = {
      enqueue: async () => ({ jobId: 'j1' }),
    } as unknown as AgentToolContext['tasks'];

    const ctx = createStandaloneToolContext({ tasks, log, signal });

    expect(ctx.tasks).toBe(tasks);
    expect(ctx.log).toBe(log);
    expect(ctx.signal).toBe(signal);
  });

  it('业务增强字段直接落 ctx 顶层', () => {
    const ctx = createStandaloneToolContext({ currentUserId: 7 });

    expect((ctx as AgentToolContext & { currentUserId?: number }).currentUserId).toBe(7);
  });

  it('与 createAgentDeps 集成：ctx 必填契约下独立组装可用', () => {
    const deps = createAgentDeps({
      registries: {
        agent: {
          getAgent: () => undefined,
          getAgentEntry: () => undefined,
          resolveAgentTools: () => [],
          resolveSubAgents: () => [],
        },
        tool: { get: () => undefined },
      },
      ctx: createStandaloneToolContext({ currentUserId: 42 }),
    });

    expect(deps.ctx).toBeDefined();
    expect((deps.ctx as AgentToolContext & { currentUserId?: number }).currentUserId).toBe(42);
  });
});
