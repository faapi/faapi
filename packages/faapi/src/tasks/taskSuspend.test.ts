import { describe, it, expect, vi } from 'vitest';
import { createTaskQueue } from './taskQueue';
import { createTaskRegistry } from './taskRegistry';
import type { TaskDriver, TaskDriverJob, TaskDriverProcess } from './driverTypes';
import type { TaskStateEntry } from './driverTypes';
import type { TaskModule } from './taskTypes';

/**
 * 任务挂起/激活语义层测试：suspend 落账与信封、resume 重投与 resumed 上下文、
 * 取消/重试分支、单飞互斥、重启水合、驱动能力边界。信封存储由两驱动适配测试
 * 覆盖，此处用内存版 fake driver 固定 TaskDriver.taskState 契约。
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
    resumeState?: { state?: unknown; inject?: unknown; activations: number };
  };
}

/** 带信封存储（taskState 可选能力）的 fake driver */
function makeFakeSuspendDriver(opts: { withTaskState?: boolean } = {}) {
  const enqueues: EnqueueCall[] = [];
  const workers = new Map<string, { concurrency: number; process: TaskDriverProcess }>();
  const dedupIds = new Map<string, string>();
  const states = new Map<string, TaskStateEntry>();
  const cancelled: { name: string; id: string }[] = [];
  let seq = 0;

  const driver: TaskDriver = {
    enqueue: async (name, payload, o) => {
      // dedupId 幂等命中返回既有 id；无 dedupId 每次新 id（key 行不推进 seq）
      if (o?.dedupId && dedupIds.has(`dedup:${o.dedupId}`))
        return dedupIds.get(`dedup:${o.dedupId}`)!;
      const id = `d-${++seq}`;
      if (o?.dedupId) dedupIds.set(`dedup:${o.dedupId}`, id);
      enqueues.push({
        name,
        payload,
        opts: {
          delayMs: o?.delayMs,
          retries: o?.retries,
          dedupId: o?.dedupId,
          groupId: o?.groupId,
          groupIndex: o?.groupIndex,
          resumeState: o?.resumeState,
        },
      });
      return id;
    },
    startWorker: (name, o) => {
      workers.set(name, o);
    },
    stop: async () => {},
    cancel: async (name, id) => {
      cancelled.push({ name, id });
    },
    retry: async () => {},
    groups: {
      create: async () => {},
      settle: async (gid, _jobId, outcome) => ({
        groupId: gid,
        task: 'chunks',
        total: 1,
        done: outcome === 'done' ? 1 : 0,
        failed: outcome === 'failed' ? 1 : 0,
        cancelled: outcome === 'cancelled' ? 1 : 0,
        settled: 1,
        status: 'settled' as const,
        completionEnqueued: false,
        onFailure: 'run-to-completion' as const,
        execution: 'parallel' as const,
        isLast: true,
      }),
      unsettle: async () => {},
      markCompletionEnqueued: async () => {},
      get: async (gid: string) => ({
        groupId: gid,
        task: 'chunks',
        total: 1,
        done: 0,
        failed: 0,
        cancelled: 0,
        settled: 0,
        status: 'open' as const,
        completionEnqueued: false,
        ...(gid === 'g1' ? { onComplete: 'summary' } : {}),
        onFailure: 'run-to-completion' as const,
        execution: 'parallel' as const,
      }),
      cancelRemaining: async () => {
        throw new Error('not mocked');
      },
      settleRemaining: async () => {
        throw new Error('not mocked');
      },
    },
    ...(opts.withTaskState === false
      ? {}
      : {
          taskState: {
            set: async (jobId: string, entry: TaskStateEntry) => {
              states.set(jobId, entry);
            },
            get: async (jobId: string) => states.get(jobId),
            delete: async (jobId: string) => {
              states.delete(jobId);
            },
            list: async () => [...states.values()],
          },
        }),
  };

  return { driver, enqueues, workers, states, cancelled };
}

/** 恒通过的透传 schema（z.unknown() 产物形态） */
const PASS_THROUGH_SCHEMA = { safeParse: (v: unknown) => ({ success: true, data: v }) };

function makeDeps(modules: Record<string, TaskModule>) {
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
  const loadPayloadSchema = vi.fn(async () => PASS_THROUGH_SCHEMA);
  return { registry, rootDir: '/fake', config: {}, loadTaskModule, loadPayloadSchema };
}

describe('taskCtx.suspend（任务挂起）', () => {
  it('挂起：任务记 suspended、信封写入（原 payload + state）、run 正常返回不记 result', async () => {
    let returned = false;
    const deps = makeDeps({
      planner: {
        run: vi.fn(
          async (
            _p: unknown,
            taskCtx: { job: { id: string }; suspend?: (s?: unknown) => Promise<void> },
          ) => {
            await taskCtx.suspend?.({ plan: 'draft' });
            returned = true;
            return 'ignored';
          },
        ),
      },
    });
    const fake = makeFakeSuspendDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.start();

    await queue.enqueue('planner', { step: 1 });
    const jobId = fake.enqueues[0] ? `d-1` : '';
    const worker = fake.workers.get('planner')!;
    await worker.process({
      id: jobId,
      name: 'planner',
      payload: { step: 1 },
      attempt: 1,
      signal: new AbortController().signal,
    } as TaskDriverJob);

    expect(returned).toBe(true); // run 正常返回（不是抛错）
    const record = queue.list('planner').find((j) => j.id === jobId);
    expect(record?.status).toBe('suspended');
    expect(record?.result).toBeUndefined();
    // 信封：原 payload + state + 计数字段
    const entry = fake.states.get(jobId)!;
    expect(entry).toMatchObject({
      jobId,
      task: 'planner',
      payload: { step: 1 },
      state: { plan: 'draft' },
      activations: 0,
    });
    await queue.stop();
  });

  it('组员挂起：组记账不落定（挂起不是终态），激活后完成才落定', async () => {
    const deps = makeDeps({ chunks: { run: vi.fn() }, summary: { run: vi.fn() } });
    deps.registry.hydrate([
      { name: 'chunks', filePath: 'dist/tasks/chunks/task.js' },
      { name: 'summary', filePath: 'dist/tasks/summary/task.js' },
    ]);
    let suspendCalled = false;
    // chunks 首次执行挂起，激活后（第二次执行）正常完成
    deps.loadTaskModule = vi.fn(async (filePath: string) => {
      const name = filePath.match(/tasks\/([^/]+)\/task\.js/)?.[1] ?? '';
      if (name === 'summary') return { run: vi.fn() } as unknown as TaskModule;
      return {
        run: vi.fn(
          async (
            _p: unknown,
            taskCtx: { job: { id: string }; suspend?: (s?: unknown) => Promise<void> },
          ) => {
            if (!suspendCalled) {
              suspendCalled = true;
              await taskCtx.suspend?.();
            }
            return 'ok';
          },
        ),
      } as unknown as TaskModule;
    });
    const fake = makeFakeSuspendDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.enqueueSequence('chunks', [{ i: 1 }], { sequenceId: 'g1', onComplete: 'summary' });
    await queue.start();

    const worker = fake.workers.get('chunks')!;
    await worker.process({
      id: 'd-1',
      name: 'chunks',
      payload: { i: 1 },
      attempt: 1,
      signal: new AbortController().signal,
      groupId: 'g1',
    });
    const snap = await queue.getGroup('g1');
    expect(snap?.settled).toBe(0); // 挂起不落定
    expect(
      fake.enqueues.find((e) => e.opts?.dedupId === 'faapi-group:g1:complete'),
    ).toBeUndefined();
    await queue.stop();
  });

  it('驱动未实现 taskState：suspend 显式抛错（能力边界）', async () => {
    const deps = makeDeps({
      planner: {
        run: vi.fn(
          async (
            _p: unknown,
            taskCtx: { job: { id: string }; suspend?: (s?: unknown) => Promise<void> },
          ) => {
            await taskCtx.suspend?.();
          },
        ),
      },
    });
    const fake = makeFakeSuspendDriver({ withTaskState: false });
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.start();

    const worker = fake.workers.get('planner')!;
    await expect(
      worker.process({
        id: 'd-1',
        name: 'planner',
        payload: {},
        attempt: 1,
        signal: new AbortController().signal,
      } as TaskDriverJob),
    ).rejects.toThrow(/taskState/);
    await queue.stop();
  });
});

describe('tasks.resume（任务激活）', () => {
  async function setupSuspended() {
    const captured: { resumed?: unknown } = {};
    const deps = makeDeps({
      planner: {
        run: vi.fn(
          async (
            _p: unknown,
            taskCtx: {
              job: { id: string };
              suspend?: (s?: unknown) => Promise<void>;
              resumed?: unknown;
            },
          ) => {
            captured.resumed = taskCtx.resumed;
            if (!taskCtx.resumed) await taskCtx.suspend?.({ plan: 'draft' });
            return 'final';
          },
        ),
      },
    });
    const fake = makeFakeSuspendDriver();
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.start();
    return { deps, fake, queue, captured };
  }

  it('激活：重投原 payload 新执行、信封读出即删、原挂起记录转 done、返回新任务 id', async () => {
    const { fake, queue } = await setupSuspended();
    await queue.enqueue('planner', { step: 1 });
    await fake.workers.get('planner')!.process({
      id: 'd-1',
      name: 'planner',
      payload: { step: 1 },
      attempt: 1,
      signal: new AbortController().signal,
    } as TaskDriverJob);
    expect(queue.list('planner').find((j) => j.id === 'd-1')?.status).toBe('suspended');

    const res = await queue.resume('planner', 'd-1', { inject: { comment: 'LGTM' } });
    expect(res).toEqual({ id: expect.any(String) });
    expect(fake.states.has('d-1')).toBe(false); // 信封读出即删
    expect(queue.list('planner').find((j) => j.id === 'd-1')?.status).toBe('done'); // 挂起周期终结
    // 重投原 payload（新执行由驱动派发，resumeState 随 enqueue 传输）
    const reEnqueue = fake.enqueues.at(-1)!;
    expect(reEnqueue.payload).toEqual({ step: 1 });
    expect(reEnqueue.opts?.resumeState).toEqual({
      state: { plan: 'draft' },
      inject: { comment: 'LGTM' },
      activations: 1,
    });
    await queue.stop();
  });

  it('激活后的执行经 taskCtx.resumed 拿到 state + inject + activations；首跑为 undefined', async () => {
    const { fake, queue, captured } = await setupSuspended();
    await queue.enqueue('planner', { step: 1 });
    // 首跑：resumed undefined + 挂起
    await fake.workers.get('planner')!.process({
      id: 'd-1',
      name: 'planner',
      payload: { step: 1 },
      attempt: 1,
      signal: new AbortController().signal,
    } as TaskDriverJob);
    expect(captured.resumed).toBeUndefined();

    // 激活 → 新执行带 resumeState
    await queue.resume('planner', 'd-1', { inject: { comment: 'LGTM' } });
    const reEnqueue = fake.enqueues.at(-1)!;
    await fake.workers.get('planner')!.process({
      id: 'd-2',
      name: 'planner',
      payload: { step: 1 },
      attempt: 1,
      signal: new AbortController().signal,
      resumeState: reEnqueue.opts!.resumeState,
    } as TaskDriverJob);
    expect(captured.resumed).toEqual({
      state: { plan: 'draft' },
      inject: { comment: 'LGTM' },
      activations: 1,
    });
    expect(queue.list('planner').find((j) => j.id === 'd-2')?.status).toBe('done');
    await queue.stop();
  });

  it('非 suspended 任务激活显式抛错；信封缺失抛错', async () => {
    const { fake, queue } = await setupSuspended();
    await queue.enqueue('planner', {});
    // pending 状态（未执行未挂起）激活 → 抛错
    await expect(queue.resume('planner', 'd-1')).rejects.toThrow(/not suspended/);
    // 挂起后手工删信封 → resume 抛信封缺失（信封是 resume 的事实源）
    await fake.workers.get('planner')!.process({
      id: 'd-1',
      name: 'planner',
      payload: {},
      attempt: 1,
      signal: new AbortController().signal,
    } as TaskDriverJob);
    fake.states.delete('d-1');
    await expect(queue.resume('planner', 'd-1')).rejects.toThrow(/envelope/);
    await queue.stop();
  });

  it('cancel 对 suspended：转 cancelled + 信封删除、不触达驱动取消；retry 显式抛错', async () => {
    const { fake, queue } = await setupSuspended();
    await queue.enqueue('planner', { step: 1 });
    await fake.workers.get('planner')!.process({
      id: 'd-1',
      name: 'planner',
      payload: { step: 1 },
      attempt: 1,
      signal: new AbortController().signal,
    } as TaskDriverJob);
    // 挂起态 retry 显式抛错（激活用 resume）
    await expect(queue.retry('planner', 'd-1')).rejects.toThrow(/suspended/);
    fake.cancelled.length = 0;

    await queue.cancel('planner', 'd-1');
    expect(queue.list('planner').find((j) => j.id === 'd-1')?.status).toBe('cancelled');
    expect(fake.states.has('d-1')).toBe(false);
    expect(fake.cancelled).toHaveLength(0); // 无活跃队列 job，不触达驱动
    await queue.stop();
  });
});

describe('suspended 与水合', () => {
  it('重启水合：start() 时从驱动信封重建 suspended 记录（含原 payload，可激活）', async () => {
    const deps = makeDeps({ planner: { run: vi.fn() } });
    const fake = makeFakeSuspendDriver();
    // 模拟重启前挂下的信封（进程内 records 为空——重启后的世界）
    fake.states.set('d-old', {
      jobId: 'd-old',
      task: 'planner',
      payload: { step: 9 },
      state: { plan: 'kept' },
      suspendedAt: Date.now() - 1000,
      activations: 0,
    });
    const queue = createTaskQueue({ ...deps, driver: fake.driver });
    await queue.start(); // 水合

    const rec = queue.list('planner').find((j) => j.id === 'd-old');
    expect(rec?.status).toBe('suspended');
    expect(rec?.payload).toEqual({ step: 9 });
    // 水合后可激活
    const res = await queue.resume('planner', 'd-old', { inject: { go: true } });
    expect(res).toEqual({ id: expect.any(String) });
    expect(fake.enqueues.at(-1)!.payload).toEqual({ step: 9 });
    await queue.stop();
  });
});
