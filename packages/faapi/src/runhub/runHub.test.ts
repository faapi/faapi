import { describe, expect, it, vi } from 'vitest';
import { createRunHub, RunConflictError, type RunHubEvent } from './runHub';

/**
 * runHub 传输中枢行为定义（语义契约见 runHub.md）
 *
 * 三组：缺省纯内存语义（冲突/同拍快照/finish 即清/溢出/外部事件/中止/订阅者
 * 生命周期）+ 持久化 SPI（append 逐事件 / sinceCursor 走 loadSince / 构造与
 * 调用期显式失败）+ 入参校验。
 */

describe('createRunHub — 缺省纯内存语义', () => {
  it('同键 running 期间再 start 抛 RunConflictError（409 / RUN_CONFLICT）；finish 后可再 start', () => {
    const hub = createRunHub<string>();
    hub.start('chat-1');
    expect(() => hub.start('chat-1')).toThrow(RunConflictError);
    try {
      hub.start('chat-1');
    } catch (err) {
      expect((err as RunConflictError).statusCode).toBe(409);
      expect((err as RunConflictError).code).toBe('RUN_CONFLICT');
      expect((err as RunConflictError).name).toBe('RunConflictError');
    }
    // 不同键不冲突
    expect(() => hub.start('chat-2')).not.toThrow();
    // finish 后同键可再 start
    hub.abort('chat-1');
    // abort 不清运行态（业务收尾后 finish）——先验证仍冲突
    expect(() => hub.start('chat-1')).toThrow(RunConflictError);
  });

  it('快照同拍：subscribe 返回注册前全部缓冲事件，实时接续其后，无缺口无重复', () => {
    const hub = createRunHub<string, string>();
    const handle = hub.start('k');
    handle.publish('delta', 'a');
    handle.publish('delta', 'b');

    const seen: RunHubEvent<string>[] = [];
    const sub = hub.subscribe('k', (e) => seen.push(e));
    expect(seen).toEqual([]); // 快照走返回值，不走回调
    expect(sub.events.map((e) => e.data)).toEqual(['a', 'b']);
    expect(sub.runId).toBe(handle.runId);
    expect(sub.truncated).toBe(false);

    handle.publish('delta', 'c');
    expect(seen.map((e) => e.data)).toEqual(['c']); // 只有订阅之后的事件走回调——无重复
    expect(sub.events.map((e) => e.data)).toEqual(['a', 'b']); // 快照不变
    // seq 严格递增，贯穿快照与实时
    const all: RunHubEvent<string>[] = [...sub.events, ...seen];
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.seq).toBeGreaterThan(all[i - 1]!.seq);
    }
  });

  it('先于 run 订阅能收全该轮；订阅者跨轮长存（空闲等下一轮 start）', () => {
    const hub = createRunHub<string>();
    const seen: number[] = [];
    const sub = hub.subscribe('k', (e) => seen.push(e.seq));
    expect(sub.runId).toBeNull();
    expect(sub.startedAt).toBeNull();
    expect(sub.events).toEqual([]);

    const h1 = hub.start('k');
    h1.publish('delta', 1);
    h1.finish();
    const h2 = hub.start('k'); // finish 后同键可再 start
    h2.publish('delta', 2);
    expect(seen).toHaveLength(2);
    expect(seen[1]!).toBeGreaterThan(seen[0]!); // seq 严格递增
    h2.finish();
  });

  it('finish 即清：isActive false、新订阅无运行态、publish 自然空操作', () => {
    const hub = createRunHub<string>();
    const handle = hub.start('k');
    handle.publish('delta', 'a');
    handle.finish();
    handle.finish(); // 幂等

    expect(hub.isActive('k')).toBe(false);
    const sub = hub.subscribe('k', () => {});
    expect(sub.events).toEqual([]);
    expect(sub.runId).toBeNull();
    expect(() => handle.publish('delta', 'b')).not.toThrow(); // 空操作不抛

    // 完结轮不重放：finish 前的事件不进入任何新订阅快照
    const h2 = hub.start('k');
    h2.publish('delta', 'x');
    const sub2 = hub.subscribe('k', () => {});
    expect(sub2.events.map((e) => e.data)).toEqual(['x']);
  });

  it('溢出丢最旧并置 truncated，订阅端据标记对账', () => {
    const hub = createRunHub<string>({ maxBuffer: 2 });
    const handle = hub.start('k');
    handle.publish('delta', 'a');
    handle.publish('delta', 'b');
    let sub = hub.subscribe('k', () => {});
    expect(sub.truncated).toBe(false);
    handle.publish('delta', 'c'); // 溢出：丢 a
    sub = hub.subscribe('k', () => {});
    expect(sub.truncated).toBe(true);
    expect(sub.events.map((e) => e.data)).toEqual(['b', 'c']);
  });

  it('外部事件 seq=0：直扇当前订阅者、不进缓冲、不进存储', () => {
    const append = vi.fn();
    const hub = createRunHub<string>({
      persistence: { append, loadSince: vi.fn(async () => []) },
    });
    const handle = hub.start('k');
    const seen: number[] = [];
    hub.subscribe('k', (e) => seen.push(e.seq));

    hub.publishExternal('k', 'stage', 'distilling');
    expect(seen).toEqual([0]);
    expect(append).not.toHaveBeenCalled(); // 不进存储

    const sub = hub.subscribe('k', () => {});
    expect(sub.events).toEqual([]); // 不进缓冲
    handle.finish();
  });

  it('无订阅者时 publishExternal 空操作', () => {
    const hub = createRunHub<string>();
    expect(() => hub.publishExternal('never-started', 'stage', 'x')).not.toThrow();
  });

  it('abort 触发 handle.signal；无 running 返回 false；不自动 finish', () => {
    const hub = createRunHub<string>();
    expect(hub.abort('k')).toBe(false); // 无运行

    const handle = hub.start('k');
    let aborted = false;
    handle.signal.addEventListener('abort', () => {
      aborted = handle.signal.reason instanceof Error;
    });
    expect(hub.abort('k')).toBe(true);
    expect(aborted).toBe(true);
    expect(hub.isActive('k')).toBe(true); // 不自动 finish——业务收尾后自清
    expect(() => hub.start('k')).toThrow(RunConflictError);
  });

  it('unsubscribe 后不再收事件；重复 unsubscribe 幂等', () => {
    const hub = createRunHub<string>();
    const handle = hub.start('k');
    const seen: string[] = [];
    const sub = hub.subscribe('k', (e) => seen.push(String(e.data)));
    handle.publish('delta', 'a');
    sub.unsubscribe();
    sub.unsubscribe();
    handle.publish('delta', 'b');
    expect(seen).toEqual(['a']);
  });

  it('单订阅者回调抛错不拖累他人（console.error 留痕）', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hub = createRunHub<string>();
      const handle = hub.start('k');
      const seen: string[] = [];
      hub.subscribe('k', () => {
        throw new Error('subscriber boom');
      });
      hub.subscribe('k', (e) => seen.push(String(e.data)));
      handle.publish('delta', 'a');
      expect(seen).toEqual(['a']);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('seq 跨 run 不清零且以键触碰时刻为基座（不透明大整数，跨进程不碰撞）', () => {
    const beforeCreate = Date.now();
    const hub = createRunHub<string>();
    const seen: number[] = [];
    hub.subscribe('k', (e) => seen.push(e.seq)); // 跨轮订阅者
    const h1 = hub.start('k');
    h1.publish('delta', 'a');
    h1.finish();
    const h2 = hub.start('k');
    h2.publish('delta', 'b');
    expect(seen).toHaveLength(2);
    expect(seen[0]!).toBeGreaterThan(beforeCreate); // 基座=时钟（游标跨进程不碰撞）
    expect(seen[1]!).toBeGreaterThan(seen[0]!); // 跨 run 不清零
  });
});

describe('createRunHub — 持久化 SPI', () => {
  it('append 被逐事件调用（key 字符串化、携带已分配 seq）；同步抛错不杀死直播', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const append = vi.fn();
      const hub = createRunHub<string>({
        persistence: { append, loadSince: vi.fn(async () => []) },
      });
      const handle = hub.start('chat-9');
      handle.publish('delta', 'a');
      handle.publish('delta', 'b');
      expect(append).toHaveBeenCalledTimes(2);
      const [k1, e1] = append.mock.calls[0]!;
      const [k2, e2] = append.mock.calls[1]!;
      expect(k1).toBe('chat-9');
      expect(k2).toBe('chat-9');
      expect(e1).toMatchObject({ event: 'delta', data: 'a' });
      expect(e2).toMatchObject({ event: 'delta', data: 'b' });
      expect(e2.seq).toBeGreaterThan(e1.seq); // seq 已分配后落存储

      // 存储故障：留痕不传播（首次 console.error），缓冲与扇出照常
      append.mockImplementation(() => {
        throw new Error('store down');
      });
      const seen: string[] = [];
      hub.subscribe('chat-9', (e) => seen.push(String(e.data)));
      handle.publish('delta', 'c');
      expect(seen).toEqual(['c']);
      expect(errSpy).toHaveBeenCalledTimes(1); // 每实例首次留痕
    } finally {
      errSpy.mockRestore();
    }
  });

  it('append 的 Promise rejection 不传播（首次留痕，成功后复位）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let fail = true;
      const append = vi.fn(async () => {
        if (fail) throw new Error('async store down');
      });
      const hub = createRunHub<string>({
        persistence: { append, loadSince: vi.fn(async () => []) },
      });
      const handle = hub.start('k');
      handle.publish('delta', 'a');
      await vi.waitFor(() => expect(errSpy).toHaveBeenCalledTimes(1));
      fail = false;
      handle.publish('delta', 'b');
      await new Promise((r) => setTimeout(r, 0)); // 等 append 成功、失败留痕标记复位
      fail = true;
      handle.publish('delta', 'c'); // 复位后再次失败 → 重新留痕
      await vi.waitFor(() => expect(errSpy).toHaveBeenCalledTimes(2));
    } finally {
      errSpy.mockRestore();
    }
  });

  it('subscribe 带 sinceCursor 走 loadSince 增量：重放+实时经 onEvent 有序去重送达', async () => {
    let loadSinceCalled: number | undefined;
    const stored = [
      { seq: 3, event: 'delta', data: 's3' },
      { seq: 4, event: 'delta', data: 's4' },
    ];
    const hub = createRunHub<string>({
      persistence: {
        append: vi.fn(),
        loadSince: vi.fn(async (_key: string, cursor: number) => {
          loadSinceCalled = cursor;
          return stored;
        }),
      },
    });
    const handle = hub.start('k');
    const seen: string[] = [];
    const sub = hub.subscribe('k', (e) => seen.push(String(e.data)), { sinceCursor: 2 });

    // 同步返回：events 恒空（store 重放路径），运行态照常
    expect(sub.events).toEqual([]);
    expect(sub.runId).toBe(handle.runId);
    expect(sub.truncated).toBe(false);
    expect(loadSinceCalled).toBe(2);

    // 重放期间发布的实时事件排队，重放批之后按到达序送达（跨进程 seq 空间不碰撞，
    // 无需去重；同进程已在 store 的事件去重见下一用例）
    handle.publish('delta', 'live-a'); // 排队
    handle.publish('delta', 'live-b'); // 排队
    await vi.waitFor(() => expect(seen).toEqual(['s3', 's4', 'live-a', 'live-b']));
    handle.finish();
  });

  it('重放期间发布的事件若已进 store（publish 同步 append）→ 去重只送一次', async () => {
    const appended: RunHubEvent[] = [];
    const hub = createRunHub<string>({
      persistence: {
        append: (_key, event) => {
          appended.push(event);
        },
        loadSince: async () => {
          await new Promise((r) => setTimeout(r, 10)); // store 读取晚于发布
          return [...appended];
        },
      },
    });
    const handle = hub.start('k');
    const seen: number[] = [];
    hub.subscribe('k', (e) => seen.push(e.seq), { sinceCursor: 0 });
    handle.publish('delta', 'a'); // 同时进 store 与实时队列
    handle.publish('delta', 'b');
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]!).toBeGreaterThan(seen[0]!); // 各送达一次，有序
  });

  it('重放期间的外部事件（seq=0）不去重、排在重放批之后', async () => {
    const hub = createRunHub<string>({
      persistence: {
        append: vi.fn(),
        loadSince: vi.fn(async () => [{ seq: 1, event: 'delta', data: 's1' }]),
      },
    });
    hub.start('k');
    const seen: Array<number | string> = [];
    hub.subscribe('k', (e) => seen.push(e.seq === 0 ? `ext:${String(e.data)}` : String(e.data)), {
      sinceCursor: 0,
    });
    hub.publishExternal('k', 'stage', 'live');
    await vi.waitFor(() => expect(seen).toEqual(['s1', 'ext:live']));
  });

  it('loadSince 失败：该次重放放弃（留痕），排队实时事件照常送达', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hub = createRunHub<string>({
        persistence: {
          append: vi.fn(),
          loadSince: vi.fn(async () => {
            throw new Error('read failed');
          }),
        },
      });
      const handle = hub.start('k');
      const seen: string[] = [];
      hub.subscribe('k', (e) => seen.push(String(e.data)), { sinceCursor: 0 });
      handle.publish('delta', 'live1');
      await vi.waitFor(() => expect(seen).toEqual(['live1']));
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('sinceCursor 未配置 persistence → 显式抛错', () => {
    const hub = createRunHub<string>();
    expect(() => hub.subscribe('k', () => {}, { sinceCursor: 5 })).toThrow(/persistence/);
  });

  it("replayPolicy 'always' 未配置 persistence → 构造期抛错；配置后每次订阅触发 loadSince(0)", async () => {
    expect(() => createRunHub<string>({ replayPolicy: 'always' })).toThrow(/persistence/);

    const loadSince = vi.fn(async (_key: string, _cursor: number) => []);
    const hub = createRunHub<string>({
      replayPolicy: 'always',
      persistence: { append: vi.fn(), loadSince },
    });
    // 空闲态订阅也重放（跨重启场景：无进行中 run 但 store 有历史）
    const sub = hub.subscribe('k', () => {});
    expect(sub.runId).toBeNull();
    await vi.waitFor(() => expect(loadSince).toHaveBeenCalledWith('k', 0));
  });
});

describe('createRunHub — 入参校验', () => {
  it('maxBuffer 非正整数构造期抛错', () => {
    expect(() => createRunHub<string>({ maxBuffer: 0 })).toThrow(/maxBuffer/);
    expect(() => createRunHub<string>({ maxBuffer: -1 })).toThrow(/maxBuffer/);
    expect(() => createRunHub<string>({ maxBuffer: 1.5 })).toThrow(/maxBuffer/);
  });

  it('未知 replayPolicy 构造期抛错', () => {
    expect(() => createRunHub<string>({ replayPolicy: 'sometimes' as 'always' })).toThrow(
      /replayPolicy/,
    );
  });
});
