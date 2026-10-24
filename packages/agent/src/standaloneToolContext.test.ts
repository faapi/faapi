import { describe, it, expect } from 'vitest';
import { createLogger } from '@faapi/faapi';
import { createStandaloneToolContext } from './standaloneToolContext';
import { createAgentDeps } from './agentDeps';
import type { AgentToolContext } from '@faapi/faapi';

/** 业务校验类型交叉标注——官方消费形态（见 standaloneToolContext.md；类型声明不进 AST 提取，extends 亦合法，此处与官方口径一致） */
type OrderCtx = { currentUserId: number } & AgentToolContext;

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

  it('类型流型：传业务字段返回可赋给业务子类型，消费点零断言', () => {
    const ctx: OrderCtx = createStandaloneToolContext({ currentUserId: 7 });

    expect(ctx.currentUserId).toBe(7);
  });

  it('类型流型：多字段精确传导，直接属性访问无需断言', () => {
    const ctx = createStandaloneToolContext({ currentUserId: 7, tags: ['a'] });

    expect(ctx.currentUserId).toBe(7);
    expect(ctx.tags).toEqual(['a']);
  });

  it('构造不完全不能调用：不传业务字段返回裸契约，赋给业务子类型编译报错', () => {
    // @ts-expect-error 构造漏传业务字段——调用点结构检查强制（构造不完全就不能调用）
    const missing: OrderCtx = createStandaloneToolContext();
    expect(missing.tasks).toBeDefined();
  });

  it('字段类型传错：构造点流型、消费点契约检查拦截', () => {
    // @ts-expect-error 流型传导 string，子类型要求 number——消费点结构检查报错
    const wrongType: OrderCtx = createStandaloneToolContext({ currentUserId: 'abc' });
    expect(wrongType.tasks).toBeDefined();
  });

  it('不传 overrides 返回可赋给裸契约', () => {
    const bare: AgentToolContext = createStandaloneToolContext();
    expect(typeof bare.log.info).toBe('function');
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
    expect(deps.ctx.currentUserId).toBe(42);
  });
});
