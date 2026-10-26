import { describe, it, expect, vi } from 'vitest';
import type { AgentToolContext } from '../runtime/agentToolContext';
import {
  createAppEventBus,
  APP_EVENT,
  agentInputEventName,
  agentRootInputEventName,
  type AgentInputEvent,
  type AgentRootInputEvent,
} from './appEventBus';

/** 最小合规 AgentToolContext 桩（契约字段 tasks/log/signal——总线单测不消费其内容） */
const toolCtx = {
  tasks: undefined,
  log: undefined,
  signal: undefined,
} as unknown as AgentToolContext;

describe('createAppEventBus', () => {
  it('on + emit：handler 收到载荷，emit 返回同一载荷', async () => {
    const bus = createAppEventBus();
    const handler = vi.fn();
    bus.on('agent:root-input', handler);

    const payload: AgentRootInputEvent = {
      input: 'go',
      ctx: toolCtx,
    };
    const returned = await bus.emit('agent:root-input', payload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
    expect(returned).toBe(payload);
  });

  it('多 handler 按注册顺序 await 依次扇出', async () => {
    const bus = createAppEventBus();
    const order: string[] = [];
    bus.on('agent:input', async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('slow-first');
    });
    bus.on('agent:input', () => {
      order.push('second');
    });

    await bus.emit('agent:input', { depth: 1, messages: [], ctx: toolCtx });

    expect(order).toEqual(['slow-first', 'second']);
  });

  it('改写串联：handler 原地修改载荷，后续 handler 与 emit 返回值可见', async () => {
    const bus = createAppEventBus();
    const seen: string[] = [];
    bus.on('agent:root-input', (e) => {
      e.input = `[a] ${e.input}`;
    });
    bus.on('agent:root-input', (e) => {
      seen.push(e.input);
      e.input = `${e.input} [b]`;
    });

    const payload: AgentRootInputEvent = { input: 'go', ctx: toolCtx };
    const returned = await bus.emit('agent:root-input', payload);

    expect(seen).toEqual(['[a] go']);
    expect(returned.input).toBe('[a] go [b]');
  });

  it('无订阅者 emit 为 no-op，原样返回载荷', async () => {
    const bus = createAppEventBus();
    const payload: AgentInputEvent = {
      depth: 1,
      messages: [{ role: 'user', content: 'x' }],
      ctx: toolCtx,
    };
    const returned = await bus.emit('agent:input', payload);
    expect(returned).toBe(payload);
  });

  it('退订后 handler 不再被调用；退订幂等', async () => {
    const bus = createAppEventBus();
    const handler = vi.fn();
    const off = bus.on('agent:root-input', handler);
    off();
    off(); // 幂等

    await bus.emit('agent:root-input', { input: 'x', ctx: toolCtx });
    expect(handler).not.toHaveBeenCalled();
  });

  it('扇出中途退订不影响在途分发（发射开始时快照生效）', async () => {
    const bus = createAppEventBus();
    const order: string[] = [];
    let offB: () => void = () => {};
    bus.on('agent:root-input', () => {
      order.push('a');
      offB(); // a 在扇出中退订 b
    });
    offB = bus.on('agent:root-input', () => {
      order.push('b');
    });
    bus.on('agent:root-input', () => {
      order.push('c');
    });

    await bus.emit('agent:root-input', { input: 'x', ctx: toolCtx });
    // 快照语义：本次 emit 内已注册的 handler 均执行
    expect(order).toEqual(['a', 'b', 'c']);

    order.length = 0;
    await bus.emit('agent:root-input', { input: 'x', ctx: toolCtx });
    // 下一次发射起 b 不再被调用
    expect(order).toEqual(['a', 'c']);
  });

  it('handler 抛错立即传播，剩余 handler 跳过（fail fast）', async () => {
    const bus = createAppEventBus();
    const after = vi.fn();
    bus.on('agent:input', () => {
      throw new Error('handler exploded');
    });
    bus.on('agent:input', after);

    await expect(
      bus.emit('agent:input', { depth: 1, messages: [], ctx: toolCtx }),
    ).rejects.toThrowError('handler exploded');
    expect(after).not.toHaveBeenCalled();
  });

  it('clear 清空全部订阅，emit 回到 no-op', async () => {
    const bus = createAppEventBus();
    const handler = vi.fn();
    bus.on('agent:root-input', handler);
    bus.on('agent:input', handler);

    bus.clear();
    await bus.emit('agent:root-input', { input: 'x', ctx: toolCtx });
    await bus.emit('agent:input', { depth: 1, messages: [], ctx: toolCtx });

    expect(handler).not.toHaveBeenCalled();
  });

  it('专属事件名 helper 产出目录内名字，载荷类型同源', async () => {
    const bus = createAppEventBus();
    const generic = vi.fn();
    const specific = vi.fn();
    bus.on('agent:input', generic);
    bus.on(agentInputEventName('writer'), specific);
    bus.on('agent:root-input', generic);
    bus.on(agentRootInputEventName('writer'), specific);

    const inputPayload = { agentName: 'writer', depth: 1, messages: [], ctx: toolCtx };
    await bus.emit('agent:input', inputPayload);
    expect(specific).not.toHaveBeenCalled(); // 通用名发射不触发专属订阅

    await bus.emit(agentInputEventName('writer'), inputPayload);
    expect(specific).toHaveBeenCalledWith(inputPayload);

    const rootPayload = { agentName: 'writer', input: 'x', ctx: toolCtx };
    await bus.emit(agentRootInputEventName('writer'), rootPayload);
    expect(specific).toHaveBeenLastCalledWith(rootPayload);
    expect(APP_EVENT.agentInput).toBe('agent:input');
    expect(APP_EVENT.agentRootInput).toBe('agent:root-input');
  });

  it('目录封闭：目录外事件名编译报错（@ts-expect-error 锚定）', async () => {
    const bus = createAppEventBus();
    // @ts-expect-error 事件目录封闭——目录外名字编译期拒绝（无 unknown 逃逸口）
    bus.on('business:custom', () => {});
    // @ts-expect-error 前缀相近但不在目录内同样拒绝
    bus.on('agent:unknown', () => {});
    expect(true).toBe(true);
  });
});
