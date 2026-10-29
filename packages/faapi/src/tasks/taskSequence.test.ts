import { describe, it, expect, vi } from 'vitest';
import { createTaskQueue } from './taskQueue';
import { createTaskRegistry } from './taskRegistry';
import { TaskCancelledError } from './taskWorker';
import type {
  TaskDriver,
  TaskDriverGroupCreate,
  TaskDriverGroupSettleResult,
  TaskDriverGroupOps,
  TaskDriverProcess,
} from './driverTypes';
import type { TaskGroupSnapshot, TaskModule } from './taskTypes';

/**
 * 顺序任务序列语义层测试：enqueueSequence 门面（批量登记 / 全量校验前置 / 幂等重投
 * 自愈）、落定即激活接线（严格顺序 / 失败语义 / 手动 cancel 不级联 / fan-in）与
 * 通用记账机制（取消落定 / retry 逆向 / 回调入队失败留痕）。此处用内存版 fake
 * driver 固定序列记账驱动契约（settle 原子推进指针返回 next / settleRemaining
 * 补齐落定），驱动子包适配测试覆盖存储映射。并行形态（enqueueBatch）见 taskBatch.test.ts。
 */

interface EnqueueCall {
  name: string;
  payload: unknown;
  opts?: {
    delayMs?: number;
    retries?: number;
    dedupId?: string;
    groupId?: string;
    groupIndex?: number;
    carry?: Record<string, unknown>;
  };
}

/** 内存版序列记账（与驱动契约同语义：成员行幂等守卫、GREATEST 指针推进、差值补齐） */
function makeMemSerialGroups() {
  const groups = new Map<
    string,
    TaskDriverGroupCreate & {
      done: number;
      failed: number;
      cancelled: number;
      completionEnqueued: boolean;
      nextIndex: number;
    }
  >();
  const members = new Map<
    string,
    Map<string, { settled: boolean; outcome?: string; memberIndex?: number }>
  >();
  const calls = { markCompletionEnqueued: 0, settleRemaining: 0 };

  const snapshot = (gid: string): TaskGroupSnapshot => {
    const g = groups.get(gid)!;
    const settled = g.done + g.failed + g.cancelled;
    return {
      groupId: g.id,
      task: g.task,
      total: g.total,
      done: g.done,
      failed: g.failed,
      cancelled: g.cancelled,
      settled,
      status: settled >= g.total ? 'settled' : 'open',
      completionEnqueued: g.completionEnqueued,
      ...(g.onComplete !== undefined ? { onComplete: g.onComplete } : {}),
      onFailure: g.onFailure,
      execution: g.mode === 'serial' ? 'serial' : 'parallel',
      ...(g.mode === 'serial' ? { nextIndex: g.nextIndex } : {}),
    };
  };

  /** 驱动契约：enqueue(opts.groupId + opts.groupIndex) 时登记成员行带序号 */
  const registerMember = (gid: string, jobId: string, memberIndex?: number) => {
    const set = members.get(gid);
    if (set && !set.has(jobId)) set.set(jobId, { settled: false, memberIndex });
  };

  const ops: TaskDriverGroupOps = {
    async create(decl) {
      const existing = groups.get(decl.id);
      if (existing) {
        if (
          existing.task !== decl.task ||
          existing.total !== decl.total ||
          existing.onComplete !== decl.onComplete ||
          existing.onFailure !== decl.onFailure ||
          existing.mode !== decl.mode ||
          JSON.stringify(existing.payloads) !== JSON.stringify(decl.payloads) ||
          JSON.stringify(existing.carry) !== JSON.stringify(decl.carry)
        ) {
          throw new Error(`[faapi] Task group "${decl.id}" already exists with different options`);
        }
        return;
      }
      groups.set(decl.id, {
        ...decl,
        done: 0,
        failed: 0,
        cancelled: 0,
        completionEnqueued: false,
        nextIndex: 0,
      });
      members.set(decl.id, new Map());
    },
    async settle(gid, jobId, outcome): Promise<TaskDriverGroupSettleResult> {
      const g = groups.get(gid);
      if (!g) throw new Error(`[faapi] Task group "${gid}" not found`);
      const set = members.get(gid)!;
      const member = set.get(jobId);
      if (member?.settled) {
        return { ...snapshot(gid), isLast: false };
      }
      if (member) {
        member.settled = true;
        member.outcome = outcome;
      } else {
        set.set(jobId, { settled: true, outcome });
      }
      g[outcome] += 1;
      // 串行激活：记账同操作推进指针（GREATEST 防回退），真推进且未到顶返回下一条；
      // fail-fast 成员最终失败不推进（终止由 settleRemaining 收口）
      const holdActivation = outcome === 'failed' && g.onFailure === 'fail-fast';
      let next: TaskDriverGroupSettleResult['next'];
      if (g.mode === 'serial' && !holdActivation && member?.memberIndex !== undefined) {
        const candidate = Math.max(g.nextIndex, member.memberIndex + 1);
        if (candidate > g.nextIndex) {
          g.nextIndex = candidate;
          if (candidate < g.total) {
            next = {
              index: candidate,
              payload: g.payloads![candidate]!,
              ...(g.carry !== undefined ? { carry: g.carry } : {}),
            };
          }
        }
      }
      const snap = snapshot(gid);
      return { ...snap, isLast: snap.settled >= snap.total, ...(next ? { next } : {}) };
    },
    async unsettle(gid, jobId) {
      const set = members.get(gid);
      const member = set?.get(jobId);
      if (!member?.settled || !member.outcome) return;
      const outcome = member.outcome as 'done' | 'failed' | 'cancelled';
      member.settled = false;
      member.outcome = undefined;
      groups.get(gid)![outcome] -= 1;
    },
    async markCompletionEnqueued(gid) {
      calls.markCompletionEnqueued += 1;
      const g = groups.get(gid);
      if (g) g.completionEnqueued = true;
    },
    async get(gid) {
      return groups.has(gid) ? snapshot(gid) : undefined;
    },
    // parallel fail-fast 专用；serial 序列语义层不调用（stub 断言误用）
    async cancelRemaining() {
      throw new Error('cancelRemaining must not be called on a serial sequence');
    },
    async settleRemaining(gid, outcome) {
      calls.settleRemaining += 1;
      const g = groups.get(gid);
      if (!g) throw new Error(`[faapi] Task group "${gid}" not found`);
      // 驱动契约：按计数差值补齐落定（未激活成员无成员行），幂等守卫防重复
      const diff = g.total - (g.done + g.failed + g.cancelled);
      if (diff > 0) g[outcome] += diff;
      return snapshot(gid);
    },
  };

  return { ops, groups, calls, snapshot, registerMember };
}

/** 带串行组记账的可编程 fake driver（成员 dedup 命中返回既有 id） */
function makeFakeSequenceDriver() {
  const enqueues: EnqueueCall[] = [];
  const workers = new Map<string, { concurrency: number; process: TaskDriverProcess }>();
  const groupOps = makeMemSerialGroups();
  const dedupIds = new Map<string, string>();
  let seq = 0;

  const driver: TaskDriver = {
    enqueue: async (name, payload, opts) => {
      const key = opts?.dedupId ? `dedup:${opts.dedupId}` : `seq:${++seq}`;
      const existing = opts?.dedupId ? dedupIds.get(key) : undefined;
      if (existing) return existing;
      const id = `d-${++seq}`;
      if (opts?.dedupId) dedupIds.set(key, id);
      enqueues.push({ name, payload, opts });
      if (opts?.groupId) groupOps.registerMember(opts.groupId, id, opts.groupIndex);
      return id;
    },
    startWorker: (name, opts) => {
      workers.set(name, opts);
    },
    stop: async () => {},
    cancel: async () => {},
    retry: async () => {},
    groups: groupOps.ops,
  };

  return { driver, enqueues, workers, groupOps };
}

/** 恒通过的透传 schema（z.unknown() 产物形态） */
const PASS_THROUGH_SCHEMA = { safeParse: (v: unknown) => ({ success: true, data: v }) };

function makeDeps(modules: Record<string, TaskModule>, schemas: Record<string, unknown> = {}) {
  const registry = createTaskRegistry();
  registry.hydrate(
    Object.keys(modules).map((name) => ({
      name,
      filePath: `dist/tasks/${name}/task.js`,
      mode: 'inline' as const,
    })),
  );
  const loadTaskModule = vi.fn(async (filePath: string) => {
    const name = filePath.match(/tasks\/([^/]+)\/task\.js/)?.[1] ?? '';
    return modules[name]!;
  });
  const loadPayloadSchema = vi.fn(async (filePath: string) => {
    const name = filePath.match(/tasks\/([^/]+)\/task\.js/)?.[1] ?? '';
    return schemas[name] ?? PASS_THROUGH_SCHEMA;
  });
  return { registry, rootDir: '/fake', config: {}, loadTaskModule, loadPayloadSchema };
}

describe('enqueueSequence（顺序任务序列）', () => {
  it('一次登记仅入队首条：sequenceId 透传、dedupId 派生 :1、payloads 持久化序列行', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() }, summary: { run: vi.fn() } });
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const res = await queue.enqueueSequence('chunks', [{ i: 1 }, { i: 2 }, { i: 3 }], {
      sequenceId: 'import:1',
      onComplete: 'summary',
    });
    expect(res.sequenceId).toBe('import:1');
    expect(res.id).toBe('d-1');
    expect(fake.enqueues).toHaveLength(1);
    expect(fake.enqueues[0]!.payload).toEqual({ i: 1 });
    expect(fake.enqueues[0]!.opts?.dedupId).toBe('faapi-group:import:1:1');
    expect(fake.enqueues[0]!.opts?.groupId).toBe('import:1');
    expect(fake.enqueues[0]!.opts?.groupIndex).toBe(0);
    // 本地记录带 groupId + groupIndex
    expect(queue.list('chunks')[0]).toMatchObject({ groupId: 'import:1', groupIndex: 0 });
    // 序列行持久化 payloads（激活数据源）
    expect(fake.groupOps.groups.get('import:1')!.payloads).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
    expect(await queue.getGroup('import:1')).toMatchObject({
      execution: 'serial',
      total: 3,
      settled: 0,
      nextIndex: 0,
    });
    await queue.stop();
  });

  it('sequenceId 缺省自动生成', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() } });
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const res = await queue.enqueueSequence('chunks', [{}]);
    expect(res.sequenceId).toMatch(/^[0-9a-f-]{36}$/);
    await queue.stop();
  });

  it('严格顺序：前一条 done 才激活下一条（payload/carry/groupIndex 正确）', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() }, summary: { run: vi.fn() } });
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    const carry = { tenantId: 7 };
    await queue.enqueueSequence('chunks', [{ i: 1 }, { i: 2 }, { i: 3 }], {
      sequenceId: 'g1',
      carry,
    });
    queue.start();

    const worker = fake.workers.get('chunks')!;
    const run = (id: string, payload: unknown) =>
      worker.process({
        id,
        name: 'chunks',
        payload,
        attempt: 1,
        signal: new AbortController().signal,
        groupId: 'g1',
      });

    expect(fake.enqueues).toHaveLength(1);
    await run('d-1', { i: 1 }); // 成员 0 落定 → 激活成员 1
    expect(fake.enqueues).toHaveLength(2);
    expect(fake.enqueues[1]!.payload).toEqual({ i: 2 });
    expect(fake.enqueues[1]!.opts?.dedupId).toBe('faapi-group:g1:2');
    expect(fake.enqueues[1]!.opts?.groupIndex).toBe(1);
    expect(fake.enqueues[1]!.opts?.carry).toEqual(carry); // 激活入队注入序列级 carry
    await run('d-2', { i: 2 }); // 成员 1 落定 → 激活成员 2
    expect(fake.enqueues).toHaveLength(3);
    expect(fake.enqueues[2]!.payload).toEqual({ i: 3 });
    expect(fake.enqueues[2]!.opts?.dedupId).toBe('faapi-group:g1:3');
    await run('d-3', { i: 3 }); // 最后一条落定 → 无 next、无回调（未声明 onComplete）
    expect(fake.enqueues).toHaveLength(3);
    expect(await queue.getGroup('g1')).toMatchObject({ done: 3, nextIndex: 3, status: 'settled' });
  });

  it('重试等待中（willRetry）不落定不激活；重试耗尽才推进', async () => {
    const deps = makeDeps({
      chunks: {
        run: vi.fn(async () => {
          throw new Error('boom');
        }),
      },
    });
    deps.registry.hydrate([
      { name: 'chunks', filePath: 'dist/tasks/chunks/task.js', mode: 'inline', retries: 1 },
    ]);
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueSequence('chunks', [{ i: 1 }, { i: 2 }], { sequenceId: 'g1' });
    queue.start();

    const worker = fake.workers.get('chunks')!;
    const run = (attempt: number) =>
      worker.process({
        id: 'd-1',
        name: 'chunks',
        payload: { i: 1 },
        attempt,
        signal: new AbortController().signal,
        groupId: 'g1',
      });
    await expect(run(1)).rejects.toThrow('boom'); // willRetry → 不落定
    expect((await queue.getGroup('g1'))!.settled).toBe(0);
    expect(fake.enqueues).toHaveLength(1); // 未激活下一条
    await expect(run(2)).rejects.toThrow('boom'); // 重试耗尽 → 落定 + 激活
    expect(fake.enqueues).toHaveLength(2);
    expect(fake.enqueues[1]!.payload).toEqual({ i: 2 });
  });

  it('run-to-completion（默认）：失败跳过继续激活下一条，回调计数如实', async () => {
    const deps = makeDeps({
      chunks: {
        run: vi.fn(async (raw: unknown) => {
          if ((raw as { i: number }).i === 2) throw new Error('chunk 2 failed');
          return { ok: true };
        }),
      },
      summary: { run: vi.fn() },
    });
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueSequence('chunks', [{ i: 1 }, { i: 2 }, { i: 3 }], {
      sequenceId: 'g1',
      onComplete: 'summary',
    });
    queue.start();

    const worker = fake.workers.get('chunks')!;
    await worker.process({
      id: 'd-1',
      name: 'chunks',
      payload: { i: 1 },
      attempt: 1,
      signal: new AbortController().signal,
      groupId: 'g1',
    });
    await expect(
      worker.process({
        id: 'd-2',
        name: 'chunks',
        payload: { i: 2 },
        attempt: 1,
        signal: new AbortController().signal,
        groupId: 'g1',
      }),
    ).rejects.toThrow();
    // 失败跳过：继续激活成员 2（0 基 index 2）
    expect(fake.enqueues).toHaveLength(3);
    expect(fake.enqueues[2]!.payload).toEqual({ i: 3 });
    await worker.process({
      id: 'd-3',
      name: 'chunks',
      payload: { i: 3 },
      attempt: 1,
      signal: new AbortController().signal,
      groupId: 'g1',
    });
    const completion = fake.enqueues.find((e) => e.opts?.dedupId === 'faapi-group:g1:complete');
    expect(completion?.payload).toMatchObject({ done: 2, failed: 1, cancelled: 0, settled: 3 });
  });

  it('fail-fast：失败终止——不激活后续、settleRemaining 补齐 cancelled、回调照常', async () => {
    const deps = makeDeps({
      chunks: {
        run: vi.fn(async (raw: unknown) => {
          if ((raw as { i: number }).i === 2) throw new Error('chunk 2 failed');
          return { ok: true };
        }),
      },
      summary: { run: vi.fn() },
    });
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueSequence('chunks', [{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }], {
      sequenceId: 'g1',
      onComplete: 'summary',
      onFailure: 'fail-fast',
    });
    queue.start();

    const worker = fake.workers.get('chunks')!;
    await worker.process({
      id: 'd-1',
      name: 'chunks',
      payload: { i: 1 },
      attempt: 1,
      signal: new AbortController().signal,
      groupId: 'g1',
    });
    await expect(
      worker.process({
        id: 'd-2',
        name: 'chunks',
        payload: { i: 2 },
        attempt: 1,
        signal: new AbortController().signal,
        groupId: 'g1',
      }),
    ).rejects.toThrow();
    expect(fake.groupOps.calls.settleRemaining).toBe(1);
    // 不激活成员 2（0 基）——成员入队停在 2 条（另一条入队是 fan-in 回调任务）
    expect(fake.enqueues.filter((e) => e.name === 'chunks')).toHaveLength(2);
    expect(fake.enqueues.some((e) => e.opts?.dedupId === 'faapi-group:g1:3')).toBe(false);
    expect(await queue.getGroup('g1')).toMatchObject({
      done: 1,
      failed: 1,
      cancelled: 2,
      status: 'settled',
    });
    const completion = fake.enqueues.find((e) => e.opts?.dedupId === 'faapi-group:g1:complete');
    expect(completion?.payload).toMatchObject({ failed: 1, cancelled: 2, settled: 4 });
  });

  it('手动 cancel 成员（fail-fast 序列）落定 cancelled 后照常激活下一条（不级联）', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() }, summary: { run: vi.fn() } });
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueSequence('chunks', [{ i: 1 }, { i: 2 }], {
      sequenceId: 'g1',
      onComplete: 'summary',
      onFailure: 'fail-fast',
    });
    queue.start();

    await queue.cancel('chunks', 'd-1');
    expect((await queue.getGroup('g1'))!).toMatchObject({ cancelled: 1 });
    expect(fake.enqueues).toHaveLength(2); // 激活成员 1
    expect(fake.groupOps.calls.settleRemaining).toBe(0); // cancelled 不触发 fail-fast 补齐
    expect(fake.enqueues[1]!.payload).toEqual({ i: 2 });
  });

  it('同 sequenceId 幂等重投：参数一致 create 跳过、首条 dedup 命中零重复入队', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() } });
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const first = await queue.enqueueSequence('chunks', [{ i: 1 }, { i: 2 }], {
      sequenceId: 'g1',
    });
    const again = await queue.enqueueSequence('chunks', [{ i: 1 }, { i: 2 }], {
      sequenceId: 'g1',
    });
    expect(again.id).toBe(first.id); // dedup 命中返回既有 id
    expect(fake.enqueues).toHaveLength(1);
    await queue.stop();
  });

  it('同 sequenceId 参数漂移（payloads 不同）抛错', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() } });
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    await queue.enqueueSequence('chunks', [{ i: 1 }], { sequenceId: 'g1' });
    await expect(queue.enqueueSequence('chunks', [{ i: 9 }], { sequenceId: 'g1' })).rejects.toThrow(
      /different options/,
    );
    await queue.stop();
  });

  it('断链自愈：指针已推进而成员未入队（激活前崩溃）时重投补投下一条', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() } });
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueSequence('chunks', [{ i: 1 }, { i: 2 }, { i: 3 }], {
      sequenceId: 'g1',
    });
    queue.start();

    // 模拟语义层在"驱动推进指针"与"激活入队"之间崩溃：直接调驱动 settle 推进（成员 0 落定），
    // 绕过语义层激活
    await fake.groupOps.ops.settle('g1', 'd-1', 'done');
    expect(fake.enqueues).toHaveLength(1); // 成员 1 未被激活

    // 重投自愈：入队 payloads[nextIndex=1]，dedupId 幂等
    await queue.enqueueSequence('chunks', [{ i: 1 }, { i: 2 }, { i: 3 }], {
      sequenceId: 'g1',
    });
    expect(fake.enqueues).toHaveLength(2);
    expect(fake.enqueues[1]!.payload).toEqual({ i: 2 });
    expect(fake.enqueues[1]!.opts?.dedupId).toBe('faapi-group:g1:2');
    await queue.stop();
  });

  it('序列已落定重投：不再入队成员（无 id），补投未入队的回调（自愈路径）', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() }, summary: { run: vi.fn() } });
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    // 直接造一个已落定、回调未入队的序列（模拟宿主在落定与回调入队之间崩溃）
    await fake.groupOps.ops.create({
      id: 'g1',
      task: 'chunks',
      total: 2,
      onComplete: 'summary',
      onFailure: 'run-to-completion',
      mode: 'serial',
      payloads: [{}, {}],
    });
    const register = fake.groupOps.registerMember;
    register('g1', 'd-a', 0);
    register('g1', 'd-b', 1);
    await fake.groupOps.ops.settle('g1', 'd-a', 'done');
    await fake.groupOps.ops.settle('g1', 'd-b', 'done');

    const res = await queue.enqueueSequence('chunks', [{}, {}], {
      sequenceId: 'g1',
      onComplete: 'summary',
    });
    expect(res.id).toBeUndefined();
    const completion = fake.enqueues.find((e) => e.opts?.dedupId === 'faapi-group:g1:complete');
    expect(completion?.name).toBe('summary');
    await queue.stop();
  });

  it('空 payloads 显式抛错；任一 payload 校验失败整序列不登记', async () => {
    const zodLike = {
      safeParse: (v: unknown) =>
        (v as { i: number }).i > 1 ? { success: true, data: v } : { success: false, error: [] },
    };
    const deps = makeDeps({ chunks: { run: vi.fn() } }, { chunks: zodLike });
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    await expect(queue.enqueueSequence('chunks', [])).rejects.toThrow(/empty/i);
    await expect(queue.enqueueSequence('chunks', [{ i: 2 }, { i: 0 }])).rejects.toThrow();
    expect(fake.enqueues).toHaveLength(0);
    await expect(queue.getGroup('g')).resolves.toBeUndefined();
    await queue.stop();
  });

  it('onComplete 任务不存在抛错；驱动未实现组记账显式抛错；停止后抛错', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() } });
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    await expect(
      queue.enqueueSequence('chunks', [{}], { onComplete: 'no-such-task' }),
    ).rejects.toThrow(/Unknown task "no-such-task"/);
    await queue.stop();
    await expect(queue.enqueueSequence('chunks', [{}])).rejects.toThrow(/stopped/i);

    const deps2 = makeDeps({ chunks: { run: vi.fn() } });
    const fake2 = makeFakeSequenceDriver();
    delete (fake2.driver as { groups?: unknown }).groups;
    const queue2 = createTaskQueue({ ...deps2, driver: fake2.driver });
    queue2.start();
    await expect(queue2.enqueueSequence('chunks', [{}])).rejects.toThrow(/group accounting/i);
    await queue2.stop();
  });

  it('delayMs 仅作用于首条入队', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() } });
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueSequence('chunks', [{ i: 1 }, { i: 2 }], {
      sequenceId: 'g1',
      delayMs: 100,
    });
    queue.start();

    expect(fake.enqueues[0]!.opts?.delayMs).toBe(100);
    const worker = fake.workers.get('chunks')!;
    await worker.process({
      id: 'd-1',
      name: 'chunks',
      payload: { i: 1 },
      attempt: 1,
      signal: new AbortController().signal,
      groupId: 'g1',
    });
    expect(fake.enqueues[1]!.opts?.delayMs).toBeUndefined(); // 激活条不附加延迟
  });
});

describe('序列记账通用机制（取消落定 / retry 逆向 / 回调失败留痕）', () => {
  it('取消路径落定 cancelled：run 抛 TaskCancelledError 且重试额度已尽（willRetry=false），落定后照常激活下一条', async () => {
    const deps = makeDeps({
      chunks: {
        run: vi.fn(async () => {
          throw new TaskCancelledError('timed out');
        }),
      },
      summary: { run: vi.fn() },
    });
    deps.registry.hydrate([
      { name: 'chunks', filePath: 'dist/tasks/chunks/task.js', mode: 'inline', retries: 1 },
      { name: 'summary', filePath: 'dist/tasks/summary/task.js', mode: 'inline' },
    ]);
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueSequence('chunks', [{ i: 1 }, { i: 2 }], {
      sequenceId: 'g1',
      onComplete: 'summary',
    });
    queue.start();

    const worker = fake.workers.get('chunks')!;
    // attempt 1 ≤ retries 1 → willRetry，不落定
    await expect(
      worker.process({
        id: 'd-1',
        name: 'chunks',
        payload: { i: 1 },
        attempt: 1,
        signal: new AbortController().signal,
        groupId: 'g1',
      }),
    ).rejects.toThrow('timed out');
    expect((await queue.getGroup('g1'))!.settled).toBe(0);
    expect(fake.enqueues).toHaveLength(1);
    // attempt 2 > retries 1 → 落定 cancelled，激活下一条
    await expect(
      worker.process({
        id: 'd-1',
        name: 'chunks',
        payload: { i: 1 },
        attempt: 2,
        signal: new AbortController().signal,
        groupId: 'g1',
      }),
    ).rejects.toThrow('timed out');
    expect((await queue.getGroup('g1'))!).toMatchObject({ cancelled: 1 });
    expect(fake.enqueues).toHaveLength(2);
    expect(fake.enqueues[1]!.payload).toEqual({ i: 2 });
    // 手动 retry 逆向记账（已落定成员撤回 pending）
    await queue.retry('chunks', 'd-1');
    expect((await queue.getGroup('g1'))!).toMatchObject({ cancelled: 0, settled: 0 });
    await queue.stop();
  });

  it('回调入队失败（summary 与回调任务 schema 不兼容）console.error 留痕且 completionEnqueued 不标记', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // 回调任务 schema 拒绝一切（与 TaskGroupSummary 不兼容的声明漂移）
      const rejectAllSchema = { safeParse: () => ({ success: false, error: [] }) };
      const deps = makeDeps(
        { chunks: { run: vi.fn() }, summary: { run: vi.fn() } },
        { summary: rejectAllSchema },
      );
      const fake = makeFakeSequenceDriver();
      const queue = createTaskQueue({ ...deps, driver: fake.driver });
      await queue.enqueueSequence('chunks', [{ i: 1 }], {
        sequenceId: 'g1',
        onComplete: 'summary',
      });
      queue.start();

      const worker = fake.workers.get('chunks')!;
      await worker.process({
        id: 'd-1',
        name: 'chunks',
        payload: { i: 1 },
        attempt: 1,
        signal: new AbortController().signal,
        groupId: 'g1',
      });
      // 成员照常 done（记账失败不改成员执行语义），回调入队失败留痕
      expect((await queue.getGroup('g1'))!).toMatchObject({ done: 1, status: 'settled' });
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('completion'), expect.anything());
      expect((await queue.getGroup('g1'))!.completionEnqueued).toBe(false);
      await queue.stop();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('无 onComplete 的序列照常记账，不入队回调', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() } });
    const fake = makeFakeSequenceDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueSequence('chunks', [{ i: 1 }], { sequenceId: 'g1' });
    queue.start();

    const worker = fake.workers.get('chunks')!;
    await worker.process({
      id: 'd-1',
      name: 'chunks',
      payload: { i: 1 },
      attempt: 1,
      signal: new AbortController().signal,
      groupId: 'g1',
    });
    expect((await queue.getGroup('g1'))!).toMatchObject({ done: 1, status: 'settled' });
    expect(fake.enqueues.every((e) => e.opts?.dedupId !== 'faapi-group:g1:complete')).toBe(true);
    expect(fake.groupOps.calls.markCompletionEnqueued).toBe(0);
  });
});
