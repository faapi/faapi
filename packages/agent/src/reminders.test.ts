import { describe, expect, it } from 'vitest';
import type { AgentToolContext, ReminderSpec } from '@faapi/faapi';
import { AgentError } from './agentErrors';
import {
  collectReminderSpecs,
  createHookReminderResolver,
  createSpecReminderResolver,
  joinReminderBlocks,
  reminderPhaseOf,
  renderReminderSpecs,
} from './reminders';

const base = { agentName: 'writer', depth: 0, ctx: {} as AgentToolContext };
const info = (turn: number) => ({ ...base, turn });

describe('reminderPhaseOf', () => {
  it('字符串 spec 默认 once', () => {
    expect(reminderPhaseOf('固定提醒')).toBe('once');
  });

  it('函数 spec 默认 everyTurn', () => {
    expect(reminderPhaseOf(() => 'x')).toBe('everyTurn');
  });

  it('对象形式缺 when 按 content 形态默认', () => {
    expect(reminderPhaseOf({ content: 'x' })).toBe('once');
    expect(reminderPhaseOf({ content: () => 'x' })).toBe('everyTurn');
  });

  it('对象形式 when 显式覆盖默认', () => {
    expect(reminderPhaseOf({ when: 'everyTurn', content: 'x' })).toBe('everyTurn');
    expect(reminderPhaseOf({ when: 'once', content: () => 'x' })).toBe('once');
  });

  it('非法 spec 形态抛 AgentError', () => {
    expect(() => reminderPhaseOf(42 as unknown as ReminderSpec)).toThrow(AgentError);
    expect(() => reminderPhaseOf({ when: 'bogus' } as unknown as ReminderSpec)).toThrow(AgentError);
    expect(() => reminderPhaseOf({} as unknown as ReminderSpec)).toThrow(AgentError);
  });
});

describe('renderReminderSpecs', () => {
  it('仅渲染命中 phase 的声明，声明序保持', async () => {
    const specs: ReminderSpec[] = [
      'once-a',
      () => 'turn-b',
      { when: 'once', content: () => 'once-c' },
      { when: 'everyTurn', content: 'turn-d' },
    ];
    expect(await renderReminderSpecs(specs, info(2), 'once')).toEqual(['once-a', 'once-c']);
    expect(await renderReminderSpecs(specs, info(2), 'everyTurn')).toEqual(['turn-b', 'turn-d']);
  });

  it('builder 收到完整 ReminderInfo', async () => {
    const seen: unknown[] = [];
    await renderReminderSpecs(
      [(i) => (seen.push(i), 'x')],
      { agentName: 'writer', depth: 2, turn: 3, ctx: base.ctx },
      'everyTurn',
    );
    expect(seen[0]).toEqual({ agentName: 'writer', depth: 2, turn: 3, ctx: base.ctx });
  });

  it('builder 返回 undefined/null/空串跳过', async () => {
    const specs: ReminderSpec[] = [
      () => undefined,
      () => null,
      () => '   ',
      () => '',
      () => '有内容',
    ];
    expect(await renderReminderSpecs(specs, info(1), 'everyTurn')).toEqual(['有内容']);
  });

  it('async builder 结果被等待', async () => {
    const specs: ReminderSpec[] = [async () => Promise.resolve('异步内容')];
    expect(await renderReminderSpecs(specs, info(1), 'everyTurn')).toEqual(['异步内容']);
  });

  it('builder 抛错包 AgentError 且带定位（agent 名 + phase + 声明序号）', async () => {
    const specs: ReminderSpec[] = [
      '正常',
      () => {
        throw new Error('boom');
      },
    ];
    const err = await renderReminderSpecs(specs, info(1), 'everyTurn').catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.message).toContain('writer');
    expect(err.message).toContain('everyTurn');
    expect(err.message).toContain('index 1');
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('builder 返回非字符串违约抛 AgentError', async () => {
    const specs = [(() => 42) as unknown as ReminderSpec];
    await expect(renderReminderSpecs(specs, info(1), 'everyTurn')).rejects.toThrow(AgentError);
  });

  it('非法 spec 形态在渲染期抛 AgentError', async () => {
    await expect(
      renderReminderSpecs([7 as unknown as ReminderSpec], info(1), 'once'),
    ).rejects.toThrow(AgentError);
  });
});

describe('joinReminderBlocks', () => {
  it('单条包裹 system-reminder 标签', () => {
    expect(joinReminderBlocks(['内容'])).toBe('<system-reminder>\n内容\n</system-reminder>');
  });

  it('多条各自包裹并以空行连接', () => {
    expect(joinReminderBlocks(['a', 'b'])).toBe(
      '<system-reminder>\na\n</system-reminder>\n\n<system-reminder>\nb\n</system-reminder>',
    );
  });

  it('空数组返回 undefined（不注入）', () => {
    expect(joinReminderBlocks([])).toBeUndefined();
  });
});

describe('collectReminderSpecs', () => {
  it('全局在前、单 agent 在后，声明序保持', () => {
    expect(collectReminderSpecs(['g1', 'g2'], ['a1'])).toEqual(['g1', 'g2', 'a1']);
  });

  it('任一来源缺省可合并', () => {
    expect(collectReminderSpecs(undefined, ['a1'])).toEqual(['a1']);
    expect(collectReminderSpecs(['g1'], undefined)).toEqual(['g1']);
    expect(collectReminderSpecs(undefined, undefined)).toEqual([]);
  });
});

describe('createSpecReminderResolver', () => {
  it('once 通道仅渲染 once 声明', async () => {
    const resolver = createSpecReminderResolver(['a', () => `t=${String(0)}`], base);
    expect(await resolver.once()).toBe('<system-reminder>\na\n</system-reminder>');
  });

  it('everyTurn 通道仅渲染 everyTurn 声明并透传 turn', async () => {
    const resolver = createSpecReminderResolver(['a', (i) => `t=${i.turn}`], base);
    expect(await resolver.everyTurn(3)).toBe('<system-reminder>\nt=3\n</system-reminder>');
  });

  it('对应通道无声明时返回 undefined', async () => {
    const resolver = createSpecReminderResolver(['a'], base);
    expect(await resolver.everyTurn(1)).toBeUndefined();
    const onlyTurn = createSpecReminderResolver([() => 'x'], base);
    expect(await onlyTurn.once()).toBeUndefined();
  });

  it('全部渲染为空时不注入', async () => {
    const resolver = createSpecReminderResolver([() => undefined], base);
    expect(await resolver.everyTurn(1)).toBeUndefined();
  });

  it('builder 抛错从解析器传播（AgentError）', async () => {
    const resolver = createSpecReminderResolver(
      [
        {
          when: 'once',
          content: () => {
            throw new Error('boom');
          },
        },
      ],
      base,
    );
    await expect(resolver.once()).rejects.toThrow(AgentError);
  });
});

describe('createHookReminderResolver', () => {
  it('once 调用钩子：phase=once、turn=0、透传 base', async () => {
    const calls: unknown[] = [];
    const resolver = createHookReminderResolver(async (i) => {
      calls.push(i);
      return ['宿主渲染'];
    }, base);
    expect(await resolver.once()).toBe('<system-reminder>\n宿主渲染\n</system-reminder>');
    expect(calls[0]).toEqual({
      agentName: 'writer',
      depth: 0,
      ctx: base.ctx,
      turn: 0,
      phase: 'once',
    });
  });

  it('everyTurn 调用钩子：phase=everyTurn、透传 turn', async () => {
    const calls: unknown[] = [];
    const resolver = createHookReminderResolver(
      async (i) => {
        calls.push(i);
        return [];
      },
      { ...base, depth: 2 },
    );
    expect(await resolver.everyTurn(4)).toBeUndefined();
    expect(calls[0]).toEqual({
      agentName: 'writer',
      depth: 2,
      ctx: base.ctx,
      turn: 4,
      phase: 'everyTurn',
    });
  });

  it('钩子返回 undefined 视为无提醒', async () => {
    const resolver = createHookReminderResolver(async () => undefined, base);
    expect(await resolver.once()).toBeUndefined();
    expect(await resolver.everyTurn(1)).toBeUndefined();
  });

  it('钩子返回多串各自包裹连接', async () => {
    const resolver = createHookReminderResolver(async () => ['a', 'b'], base);
    expect(await resolver.once()).toBe(
      '<system-reminder>\na\n</system-reminder>\n\n<system-reminder>\nb\n</system-reminder>',
    );
  });
});
