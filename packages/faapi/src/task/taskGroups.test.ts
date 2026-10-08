import { describe, it, expect, vi } from 'vitest';
import { createTaskQueue } from './taskQueue';
import { createTaskRegistry } from './taskRegistry';
import { TaskCancelledError } from './taskWorker';
import type {
  TaskDriver,
  TaskDriverGroupCreate,
  TaskDriverGroupSettleResult,
  TaskDriverGroupOps,
  TaskDriverJob,
  TaskDriverProcess,
} from './driverTypes';
import type { TaskGroupSnapshot, TaskModule } from './taskTypes';

/**
 * 任务组语义层测试：组投递门面（全量校验前置 / 幂等重投 / 能力边界）与
 * runJob 终态落定接线（计数 / fan-in 回调 / fail-fast / 逆向记账）。
 * 组记账存储语义由驱动子包适配测试覆盖，此处用内存版 fake driver 固定
 * TaskDriverGroupOps 契约。
 */

interface EnqueueCall {
  name: string;
  payload: unknown;
  opts?: { delayMs?: number; retries?: number; dedupId?: string; groupId?: string };
}

/** 内存版组记账（与驱动契约同语义：成员行幂等守卫、unsettle 逆向、参数一致性） */
function makeMemGroups() {
  const groups = new Map<
    string,
    TaskDriverGroupCreate & {
      done: number;
      failed: number;
      cancelled: number;
      completionEnqueued: boolean;
    }
  >();
  const members = new Map<string, Map<string, { settled: boolean; outcome?: string }>>();
  const calls = { markCompletionEnqueued: 0, cancelRemaining: 0 };

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
    };
  };

  /** 驱动契约：enqueue(opts.groupId) 时登记成员行（真实驱动为成员表插入） */
  const registerMember = (gid: string, jobId: string) => {
    const set = members.get(gid);
    if (set && !set.has(jobId)) set.set(jobId, { settled: false });
  };

  const ops: TaskDriverGroupOps = {
    async create(decl) {
      const existing = groups.get(decl.id);
      if (existing) {
        if (
          existing.task !== decl.task ||
          existing.total !== decl.total ||
          existing.onComplete !== decl.onComplete ||
          existing.onFailure !== decl.onFailure
        ) {
          throw new Error(`[faapi] Task group "${decl.id}" already exists with different options`);
        }
        return;
      }
      groups.set(decl.id, { ...decl, done: 0, failed: 0, cancelled: 0, completionEnqueued: false });
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
      const snap = snapshot(gid);
      return { ...snap, isLast: snap.settled >= snap.total };
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
    async cancelRemaining(gid) {
      calls.cancelRemaining += 1;
      // 驱动契约：实际取消成功的未落定成员落定 cancelled（幂等守卫防与运行实例竞态重复计数）
      const set = members.get(gid)!;
      for (const [jobId, member] of set) {
        if (!member.settled) await ops.settle(gid, jobId, 'cancelled');
      }
      return snapshot(gid);
    },
  };

  return { ops, groups, calls, snapshot, registerMember };
}

/** 带组记账的可编程 fake driver（成员 dedup 命中返回既有 id） */
function makeFakeGroupDriver() {
  const enqueues: EnqueueCall[] = [];
  const workers = new Map<string, { concurrency: number; process: TaskDriverProcess }>();
  const groupOps = makeMemGroups();
  const dedupIds = new Map<string, string>();
  let seq = 0;

  const dispatch = async (name: string, payload: unknown, attempt = 1): Promise<unknown> => {
    const worker = workers.get(name);
    if (!worker) throw new Error(`no worker registered for "${name}"`);
    const job: TaskDriverJob = {
      id: `d-${seq}`,
      name,
      payload,
      attempt,
      signal: new AbortController().signal,
    };
    return worker.process(job);
  };

  const driver: TaskDriver = {
    enqueue: async (name, payload, opts) => {
      const key = opts?.dedupId ? `dedup:${opts.dedupId}` : `seq:${++seq}`;
      const existing = opts?.dedupId ? dedupIds.get(key) : undefined;
      if (existing) return existing;
      const id = `d-${++seq}`;
      if (opts?.dedupId) dedupIds.set(key, id);
      enqueues.push({ name, payload, opts });
      if (opts?.groupId) groupOps.registerMember(opts.groupId, id);
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

  return { driver, enqueues, workers, groupOps, dispatch };
}

/** 恒通过的透传 schema（z.unknown() 产物形态） */
const PASS_THROUGH_SCHEMA = { safeParse: (v: unknown) => ({ success: true, data: v }) };

function makeDeps(modules: Record<string, TaskModule>, schemas: Record<string, unknown> = {}) {
  const registry = createTaskRegistry();
  registry.hydrate(
    Object.keys(modules).map((name) => ({
      name,
      filePath: `dist/tasks/${name}/task.js`,
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

describe('enqueueGroup（组投递）', () => {
  it('N 个成员全部入队：groupId 透传驱动、dedupId 自动派生、本地记录带 groupId', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() }, summary: { run: vi.fn() } });
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const res = await queue.enqueueGroup('chunks', [{ i: 1 }, { i: 2 }, { i: 3 }], {
      groupId: 'import:1',
      onComplete: 'summary',
    });
    expect(res.groupId).toBe('import:1');
    expect(res.jobs).toEqual([{ id: 'd-1' }, { id: 'd-2' }, { id: 'd-3' }]);
    expect(fake.enqueues).toHaveLength(3);
    expect(fake.enqueues.map((e) => e.opts?.dedupId)).toEqual([
      'faapi-group:import:1:1',
      'faapi-group:import:1:2',
      'faapi-group:import:1:3',
    ]);
    expect(fake.enqueues.every((e) => e.opts?.groupId === 'import:1')).toBe(true);
    expect(queue.list('chunks').every((j) => j.groupId === 'import:1')).toBe(true);
    await queue.stop();
  });

  it('groupId 缺省自动生成；delayMs 透传各成员', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() } });
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const res = await queue.enqueueGroup('chunks', [{}, {}], { delayMs: 100 });
    expect(res.groupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.enqueues.every((e) => e.opts?.delayMs === 100)).toBe(true);
    await queue.stop();
  });

  it('空 payloads 显式抛错（组无成员 fan-in 永不触发）', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() } });
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    await expect(queue.enqueueGroup('chunks', [])).rejects.toThrow(/empty/i);
    expect(fake.enqueues).toHaveLength(0);
    await queue.stop();
  });

  it('任一 payload 校验失败整组不投递（全量校验前置）', async () => {
    const zodLike = {
      safeParse: (v: unknown) =>
        (v as { i: number }).i > 1 ? { success: true, data: v } : { success: false, error: [] },
    };
    const deps = makeDeps({ chunks: { run: vi.fn() } }, { chunks: zodLike });
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    await expect(queue.enqueueGroup('chunks', [{ i: 2 }, { i: 0 }])).rejects.toThrow();
    expect(fake.enqueues).toHaveLength(0);
    await expect(queue.getGroup('g')).resolves.toBeUndefined();
    await queue.stop();
  });

  it('onComplete 任务不存在抛错，不触达驱动', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() } });
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    await expect(
      queue.enqueueGroup('chunks', [{}], { onComplete: 'no-such-task' }),
    ).rejects.toThrow(/Unknown task "no-such-task"/);
    expect(fake.enqueues).toHaveLength(0);
    await queue.stop();
  });

  it('驱动未实现组记账（TaskDriver.groups 缺失）显式抛错', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() } });
    const fake = makeFakeGroupDriver();
    delete (fake.driver as { groups?: unknown }).groups;
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    await expect(queue.enqueueGroup('chunks', [{}])).rejects.toThrow(/group accounting/i);
    await expect(queue.getGroup('g')).rejects.toThrow(/group accounting/i);
    await queue.stop();
  });

  it('同 groupId 幂等重投：create 不重复、成员 dedup 命中返回既有 id', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() }, summary: { run: vi.fn() } });
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    const first = await queue.enqueueGroup('chunks', [{ i: 1 }, { i: 2 }], { groupId: 'g1' });
    const again = await queue.enqueueGroup('chunks', [{ i: 1 }, { i: 2 }], { groupId: 'g1' });
    expect(again.jobs).toEqual(first.jobs);
    expect(fake.enqueues).toHaveLength(2);
    await queue.stop();
  });

  it('组已落定而回调未入队时幂等重投补投回调（自愈路径）', async () => {
    const summaryRun = vi.fn();
    const deps = makeDeps({ chunks: { run: vi.fn() }, summary: { run: summaryRun } });
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    // 直接造一个已落定、回调未入队的组（模拟宿主在落定与回调入队之间崩溃）
    await fake.groupOps.ops.create({
      id: 'g1',
      task: 'chunks',
      total: 2,
      onComplete: 'summary',
      onFailure: 'run-to-completion',
    });
    await fake.groupOps.ops.settle('g1', 'd-a', 'done');
    await fake.groupOps.ops.settle('g1', 'd-b', 'done');

    await queue.enqueueGroup('chunks', [{}, {}], { groupId: 'g1', onComplete: 'summary' });
    expect(fake.groupOps.calls.markCompletionEnqueued).toBe(1);
    const completion = fake.enqueues.find((e) => e.opts?.dedupId === 'faapi-group:g1:complete');
    expect(completion?.name).toBe('summary');
    await queue.stop();
  });

  it('队列停止后 enqueueGroup 抛错', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() } });
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();
    await queue.stop();

    await expect(queue.enqueueGroup('chunks', [{}])).rejects.toThrow(/stopped/i);
  });
});

describe('成员落定接线（fan-in / 失败语义 / 逆向记账）', () => {
  it('全部成员 done → 回调入队一次（summary payload 契约 + markCompletionEnqueued）', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() }, summary: { run: vi.fn() } });
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueGroup('chunks', [{ i: 1 }, { i: 2 }], {
      groupId: 'g1',
      onComplete: 'summary',
    });
    queue.start();

    const memberIds = fake.enqueues.map((_e, i) => `d-${i + 1}`);
    for (let i = 0; i < memberIds.length; i++) {
      const worker = fake.workers.get('chunks')!;
      await worker.process({
        id: memberIds[i]!,
        name: 'chunks',
        payload: { i: i + 1 },
        attempt: 1,
        signal: new AbortController().signal,
        groupId: 'g1',
      });
    }

    const snap = await queue.getGroup('g1');
    expect(snap).toMatchObject({ total: 2, done: 2, failed: 0, cancelled: 0, status: 'settled' });
    const completion = fake.enqueues.find((e) => e.opts?.dedupId === 'faapi-group:g1:complete');
    expect(completion).toBeDefined();
    expect(completion!.name).toBe('summary');
    expect(completion!.payload).toEqual({
      groupId: 'g1',
      task: 'chunks',
      total: 2,
      done: 2,
      failed: 0,
      cancelled: 0,
      settled: 2,
    });
    expect(fake.groupOps.calls.markCompletionEnqueued).toBe(1);
  });

  it('成员失败但重试额度未尽（willRetry）不落定；耗尽后落定 failed 并触发回调', async () => {
    const deps = makeDeps({
      chunks: {
        run: vi.fn(async () => {
          throw new Error('boom');
        }),
      },
      summary: { run: vi.fn() },
    });
    // meta retries=1：attempt 1 失败 willRetry=true，attempt 2 失败才落定
    deps.registry.hydrate([
      { name: 'chunks', filePath: 'dist/tasks/chunks/task.js', retries: 1 },
      { name: 'summary', filePath: 'dist/tasks/summary/task.js' },
    ]);
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueGroup('chunks', [{ i: 1 }], { groupId: 'g1', onComplete: 'summary' });
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
    await expect(run(2)).rejects.toThrow('boom'); // 重试耗尽 → 落定 failed
    const snap = await queue.getGroup('g1');
    expect(snap).toMatchObject({ failed: 1, status: 'settled' });
    const completion = fake.enqueues.find((e) => e.opts?.dedupId === 'faapi-group:g1:complete');
    expect(completion?.payload).toMatchObject({ failed: 1, done: 0 });
  });

  it('run-to-completion（默认）：成员最终失败后其余成员照常执行，回调计数准确', async () => {
    const deps = makeDeps({
      chunks: {
        run: vi.fn(async (raw: unknown) => {
          const payload = raw as { i: number };
          if (payload.i === 1) throw new Error('batch 1 failed');
          return { ok: true };
        }),
      },
      summary: { run: vi.fn() },
    });
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueGroup('chunks', [{ i: 1 }, { i: 2 }], {
      groupId: 'g1',
      onComplete: 'summary',
    });
    queue.start();

    const worker = fake.workers.get('chunks')!;
    // 第一个成员失败（retries=0 → 直接落定 failed），不触发 cancelRemaining
    await expect(
      worker.process({
        id: 'd-1',
        name: 'chunks',
        payload: { i: 1 },
        attempt: 1,
        signal: new AbortController().signal,
        groupId: 'g1',
      }),
    ).rejects.toThrow();
    expect(fake.groupOps.calls.cancelRemaining).toBe(0);
    // 第二个成员成功落定 → 组齐 → 回调
    await worker.process({
      id: 'd-2',
      name: 'chunks',
      payload: { i: 2 },
      attempt: 1,
      signal: new AbortController().signal,
      groupId: 'g1',
    });
    expect((await queue.getGroup('g1'))!).toMatchObject({ failed: 1, done: 1, status: 'settled' });
    const completion = fake.enqueues.find((e) => e.opts?.dedupId === 'faapi-group:g1:complete');
    expect(completion?.payload).toMatchObject({ done: 1, failed: 1 });
  });

  it('fail-fast：成员最终失败触发 cancelRemaining；cancelled 成员落定后回调照常', async () => {
    const deps = makeDeps({
      chunks: {
        run: vi.fn(async (raw: unknown) => {
          const payload = raw as { i: number };
          if (payload.i === 1) throw new Error('batch 1 failed');
          return { ok: true };
        }),
      },
      summary: { run: vi.fn() },
    });
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueGroup('chunks', [{ i: 1 }, { i: 2 }], {
      groupId: 'g1',
      onComplete: 'summary',
      onFailure: 'fail-fast',
    });
    queue.start();

    const worker = fake.workers.get('chunks')!;
    await expect(
      worker.process({
        id: 'd-1',
        name: 'chunks',
        payload: { i: 1 },
        attempt: 1,
        signal: new AbortController().signal,
        groupId: 'g1',
      }),
    ).rejects.toThrow();
    expect(fake.groupOps.calls.cancelRemaining).toBe(1);
    // cancelRemaining 取消余下成员（落定 cancelled）→ 组齐 → 回调照常触发
    const completion = fake.enqueues.find((e) => e.opts?.dedupId === 'faapi-group:g1:complete');
    expect(completion?.payload).toMatchObject({ failed: 1, cancelled: 1, settled: 2 });
  });

  it('取消路径落定 cancelled：run 抛 TaskCancelledError 且重试额度已尽（willRetry=false）', async () => {
    const deps = makeDeps({
      chunks: {
        run: vi.fn(async () => {
          throw new TaskCancelledError('timed out');
        }),
      },
      summary: { run: vi.fn() },
    });
    deps.registry.hydrate([
      { name: 'chunks', filePath: 'dist/tasks/chunks/task.js', retries: 1 },
      { name: 'summary', filePath: 'dist/tasks/summary/task.js' },
    ]);
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueGroup('chunks', [{ i: 1 }], { groupId: 'g1', onComplete: 'summary' });
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
    // attempt 2 > retries 1 → 落定 cancelled
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
    expect((await queue.getGroup('g1'))!).toMatchObject({ cancelled: 1, status: 'settled' });
    const completion = fake.enqueues.find((e) => e.opts?.dedupId === 'faapi-group:g1:complete');
    expect(completion?.payload).toMatchObject({ cancelled: 1, failed: 0 });
  });

  it('手动 tasks.cancel(成员) 落定 cancelled；retry(已落定成员) 逆向记账', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() }, summary: { run: vi.fn() } });
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueGroup('chunks', [{ i: 1 }, { i: 2 }], { groupId: 'g1' });
    queue.start();

    await queue.cancel('chunks', 'd-1');
    expect((await queue.getGroup('g1'))!).toMatchObject({ cancelled: 1 });
    // retry 把已落定成员撤回 pending → 逆向记账
    await queue.retry('chunks', 'd-1');
    expect((await queue.getGroup('g1'))!).toMatchObject({ cancelled: 0, settled: 0 });
  });

  it('无 onComplete 的组照常记账，不入队回调', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() } });
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueGroup('chunks', [{ i: 1 }], { groupId: 'g1' });
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

  it('回调入队失败（summary 与回调任务 schema 不兼容）console.error 留痕且 completionEnqueued 不标记', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // 回调任务 schema 拒绝一切（与 TaskGroupSummary 不兼容的声明漂移）
      const rejectAllSchema = { safeParse: () => ({ success: false, error: [] }) };
      const deps = makeDeps(
        { chunks: { run: vi.fn() }, summary: { run: vi.fn() } },
        { summary: rejectAllSchema },
      );
      const fake = makeFakeGroupDriver();
      const queue = createTaskQueue({ ...deps, driver: fake.driver });
      await queue.enqueueGroup('chunks', [{ i: 1 }], { groupId: 'g1', onComplete: 'summary' });
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
});

describe('taskCtx.tasks（任务侧客户端）', () => {
  it('进程内任务的 taskCtx.tasks 即队列本体：任务内扇出经其入队', async () => {
    let seenTasks: unknown;
    const deps = makeDeps({
      fanout: {
        run: vi.fn(async (_payload: unknown, taskCtx: { tasks?: unknown }) => {
          seenTasks = taskCtx.tasks;
          return 'ok';
        }),
      },
      chunks: { run: vi.fn() },
    });
    const fake = makeFakeGroupDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    queue.start();

    await queue.enqueue('fanout', {});
    const worker = fake.workers.get('fanout')!;
    await worker.process({
      id: 'd-1',
      name: 'fanout',
      payload: {},
      attempt: 1,
      signal: new AbortController().signal,
    });
    expect(seenTasks).toBe(queue);
    await queue.stop();
  });
});
