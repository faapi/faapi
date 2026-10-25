import { describe, expect, it } from 'vitest';
import type { AgentToolContext } from '@faapi/faapi';
import { AgentError } from './agentErrors';
import { createHookReminderResolver, joinReminderBlocks } from './reminders';

const base = { agentName: 'writer', depth: 0, ctx: {} as AgentToolContext };

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

  it('钩子抛错包 AgentError 且带定位（agent 名 + phase）', async () => {
    const resolver = createHookReminderResolver(async () => {
      throw new Error('boom');
    }, base);
    const err = await resolver.everyTurn(1).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.message).toContain('writer');
    expect(err.message).toContain('everyTurn');
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.cause.message).toBe('boom');
  });

  it('钩子返回非数组（字符串）抛 AgentError——返回类型违约', async () => {
    const resolver = createHookReminderResolver(
      async () => '裸字符串' as unknown as string[],
      base,
    );
    await expect(resolver.once()).rejects.toThrow(AgentError);
  });

  it('钩子返回数组含非 string 元素抛 AgentError——返回类型违约', async () => {
    const resolver = createHookReminderResolver(async () => [42] as unknown as string[], base);
    await expect(resolver.everyTurn(1)).rejects.toThrow(AgentError);
  });
});
